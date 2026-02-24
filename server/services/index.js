import { FileService } from '../node_modules/files/index.js';
import { loadApps, getAppList } from '../loader.js';

/**
 * Service Router for HomeChannel Server
 * Routes messages from datachannel to appropriate service
 * Supports apps-control channel and per-app channels
 */

export class ServiceRouter {
  constructor(config = {}) {
    this.services = {};
    this.config = config;
    this.apps = new Map();      // name -> loaded app with instance
    this.appErrors = [];        // structured errors from loading
    
    // Initialize services based on config
    // Always create the service instance, but store enabled state
    if (config.files) {
      this.services.files = new FileService(config.files);
    } else {
      // Default to enabled with default config
      this.services.files = new FileService({});
    }
  }

  /**
   * Load apps from config
   * @param {string[]} appNames - Array of app names to load
   * @param {object} appsConfig - Per-app config keyed by app name
   */
  async loadApps(appNames = [], appsConfig = {}) {
    const { loaded, errors } = await loadApps(appNames, appsConfig);
    this.apps = loaded;
    this.appErrors = errors;
    return { loaded: this.apps, errors: this.appErrors };
  }

  /**
   * Handle apps-control channel messages
   * @param {object} message - Parsed JSON message
   * @returns {object} Response
   */
  async handleControlMessage(message) {
    const { type, requestId } = message;

    if (type === 'apps:list') {
      return {
        type: 'apps:list:response',
        requestId: requestId || null,
        apps: getAppList(this.apps)
      };
    }

    return {
      type: 'error',
      requestId: requestId || null,
      error: `Unknown control message type: ${type}`
    };
  }

  /**
   * Handle per-app channel message
   * Routes to the app's handleMessage if available
   * @param {string} appName - Name of the app (channel label)
   * @param {object} message - Parsed JSON message
   * @returns {object} Response
   */
  async handleAppMessage(appName, message) {
    const app = this.apps.get(appName);
    if (!app) {
      return {
        requestId: message.requestId || null,
        success: false,
        error: `Unknown app: ${appName}`
      };
    }

    if (!app.instance || typeof app.instance.handleMessage !== 'function') {
      return {
        requestId: message.requestId || null,
        success: false,
        error: `App ${appName} does not support messages`
      };
    }

    try {
      return await app.instance.handleMessage(message);
    } catch (error) {
      return {
        requestId: message.requestId || null,
        success: false,
        error: error.message || 'App error'
      };
    }
  }

  /**
   * Handle incoming message from datachannel
   * Message format: { requestId, service, operation, params }
   * Returns: { requestId, success, result/error }
   */
  async handleMessage(message) {
    const { requestId, service, operation, params } = message;

    // Validate message structure
    if (!requestId) {
      return {
        requestId: null,
        success: false,
        error: 'Missing requestId'
      };
    }

    if (!service) {
      return {
        requestId,
        success: false,
        error: 'Missing service name'
      };
    }

    if (!operation) {
      return {
        requestId,
        success: false,
        error: 'Missing operation name'
      };
    }

    // Check if service exists
    const serviceInstance = this.services[service];
    if (!serviceInstance) {
      return {
        requestId,
        success: false,
        error: `Unknown service: ${service}`
      };
    }

    // Check if service is enabled
    if (serviceInstance.enabled === false) {
      return {
        requestId,
        success: false,
        error: `Service disabled: ${service}`
      };
    }

    // Check if operation exists
    if (typeof serviceInstance[operation] !== 'function') {
      return {
        requestId,
        success: false,
        error: `Unknown operation: ${operation}`
      };
    }

    // Execute operation
    try {
      const result = await serviceInstance[operation](params || {});
      return {
        requestId,
        success: true,
        result
      };
    } catch (error) {
      // Return sanitized error message (no stack traces)
      return {
        requestId,
        success: false,
        error: error.message || 'Operation failed'
      };
    }
  }

  /**
   * Get list of available services and operations
   */
  getAvailableServices() {
    const available = {};
    
    for (const [serviceName, serviceInstance] of Object.entries(this.services)) {
      if (serviceInstance.enabled !== false) {
        // Get all public methods (not starting with _)
        const operations = Object.getOwnPropertyNames(Object.getPrototypeOf(serviceInstance))
          .filter(name => {
            return name !== 'constructor' && 
                   !name.startsWith('_') && 
                   typeof serviceInstance[name] === 'function';
          });
        
        available[serviceName] = {
          enabled: true,
          operations
        };
      }
    }
    
    return available;
  }
}
