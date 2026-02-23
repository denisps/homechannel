import { promises as fsPromises } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Required manifest fields and their types
 */
const MANIFEST_REQUIRED_FIELDS = {
  name: 'string',
  version: 'string',
  entry: 'string'
};

/**
 * Validate an app manifest object
 * @param {object} manifest - Parsed manifest JSON
 * @param {string} appName - Expected app name
 * @returns {{ valid: boolean, error?: string }}
 */
export function validateManifest(manifest, appName) {
  if (!manifest || typeof manifest !== 'object') {
    return { valid: false, error: 'Manifest is not a valid object' };
  }

  for (const [field, type] of Object.entries(MANIFEST_REQUIRED_FIELDS)) {
    if (typeof manifest[field] !== type) {
      return { valid: false, error: `Manifest missing or invalid field: ${field}` };
    }
  }

  if (manifest.name !== appName) {
    return { valid: false, error: `Manifest name "${manifest.name}" does not match app name "${appName}"` };
  }

  return { valid: true };
}

/**
 * Load a single app by name
 * Returns structured result (never throws)
 * @param {string} appName - Name of the app directory
 * @param {object} appConfig - Per-app configuration
 * @returns {Promise<{ name: string, manifest?: object, module?: object, instance?: object, error?: string }>}
 */
export async function loadApp(appName, appConfig = {}) {
  const appDir = path.join(__dirname, appName);

  // Check app directory exists
  try {
    const stat = await fsPromises.stat(appDir);
    if (!stat.isDirectory()) {
      return { name: appName, error: `App path is not a directory: ${appName}` };
    }
  } catch (error) {
    return { name: appName, error: `App directory not found: ${appName}` };
  }

  // Load and validate manifest
  let manifest;
  const manifestPath = path.join(appDir, 'manifest.json');
  try {
    const raw = await fsPromises.readFile(manifestPath, 'utf8');
    manifest = JSON.parse(raw);
  } catch (error) {
    return { name: appName, error: `Failed to read manifest: ${error.message}` };
  }

  const validation = validateManifest(manifest, appName);
  if (!validation.valid) {
    return { name: appName, error: validation.error };
  }

  // Load module
  let appModule;
  const entryPath = path.join(appDir, manifest.entry);
  try {
    await fsPromises.access(entryPath);
  } catch (error) {
    return { name: appName, error: `Entry file not found: ${manifest.entry}` };
  }

  try {
    appModule = await import(entryPath);
  } catch (error) {
    return { name: appName, error: `Failed to import app module: ${error.message}` };
  }

  if (typeof appModule.run !== 'function') {
    return { name: appName, error: 'App module does not export a run() function' };
  }

  // Invoke app entry point
  let instance;
  try {
    instance = await appModule.run({ config: appConfig });
  } catch (error) {
    return { name: appName, error: `App run() failed: ${error.message}` };
  }

  return { name: appName, manifest, module: appModule, instance };
}

/**
 * Load all enabled apps from config
 * Skips apps that fail validation/loading (returns structured errors)
 * @param {string[]} appNames - Array of app names to load
 * @param {object} appsConfig - Per-app config keyed by app name
 * @returns {Promise<{ loaded: Map<string, object>, errors: Array<{ name: string, error: string }> }>}
 */
export async function loadApps(appNames = [], appsConfig = {}) {
  const loaded = new Map();
  const errors = [];

  for (const appName of appNames) {
    const result = await loadApp(appName, appsConfig[appName] || {});
    if (result.error) {
      errors.push({ name: result.name, error: result.error });
    } else {
      loaded.set(appName, result);
    }
  }

  return { loaded, errors };
}

/**
 * Get app list metadata for control channel response
 * @param {Map<string, object>} loadedApps - Map of loaded apps
 * @returns {Array<object>} App metadata array
 */
export function getAppList(loadedApps) {
  const apps = [];
  for (const [name, app] of loadedApps) {
    apps.push({
      name: app.manifest.name,
      version: app.manifest.version,
      description: app.manifest.description || '',
      format: app.manifest.format || 'es-module',
      entry: app.manifest.entry
    });
  }
  return apps;
}
