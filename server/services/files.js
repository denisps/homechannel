import { promises as fsPromises } from 'fs';
import path from 'path';
import { constants } from 'fs';

/**
 * Custom error classes for file operations
 */
class PathTraversalError extends Error {
  constructor(message = 'Path traversal not allowed') {
    super(message);
    this.name = 'PathTraversalError';
  }
}

class AccessDeniedError extends Error {
  constructor(message = 'Access denied') {
    super(message);
    this.name = 'AccessDeniedError';
  }
}

class NotAFileError extends Error {
  constructor(message = 'Not a file') {
    super(message);
    this.name = 'NotAFileError';
  }
}

/**
 * File Service for HomeChannel Server
 * Provides secure file operations over datachannel
 */

export class FileService {
  constructor(config = {}) {
    this.rootDir = path.resolve(config.rootDir || process.cwd());
    this.allowedDirs = (config.allowedDirs || [this.rootDir]).map(d => path.resolve(d));
    this.maxFileSize = config.maxFileSize || 104857600; // 100MB default
    this.enabled = config.enabled !== false;
  }

  /**
   * Validate path is within allowed directories and has no traversal attacks
   */
  validatePath(requestedPath) {
    // Check for path traversal attempts before normalization
    // This catches literal '..' in the path
    if (requestedPath.includes('..')) {
      throw new PathTraversalError();
    }

    // Normalize to handle encoded sequences and resolve the path
    const normalized = path.normalize(requestedPath);
    const resolved = path.resolve(normalized);

    // Ensure path is within allowed directories
    const isAllowed = this.allowedDirs.some(allowedDir => {
      return resolved === allowedDir || resolved.startsWith(allowedDir + path.sep);
    });

    if (!isAllowed) {
      throw new AccessDeniedError('Access denied: path outside allowed directories');
    }

    return resolved;
  }

  /**
   * List files and directories at the given path
   */
  async listDirectory(params) {
    const targetPath = this.validatePath(params.path);

    try {
      const entries = await fsPromises.readdir(targetPath, { withFileTypes: true });
      const items = await Promise.all(
        entries.map(async (entry) => {
          const fullPath = path.join(targetPath, entry.name);
          try {
            const stats = await fsPromises.stat(fullPath);
            return {
              name: entry.name,
              type: entry.isDirectory() ? 'directory' : 'file',
              size: stats.size,
              modified: stats.mtimeMs
            };
          } catch (err) {
            // Skip files we can't stat
            return null;
          }
        })
      );

      return { items: items.filter(item => item !== null) };
    } catch (error) {
      if (error.code === 'ENOENT') {
        throw new Error('Directory not found');
      }
      if (error.code === 'EACCES') {
        throw new Error('Access denied');
      }
      throw new Error(`Failed to list directory: ${error.message}`);
    }
  }

  /**
   * Read file contents
   */
  async readFile(params) {
    const targetPath = this.validatePath(params.path);

    try {
      const stats = await fsPromises.stat(targetPath);

      if (!stats.isFile()) {
        throw new Error('Not a file');
      }

      if (stats.size > this.maxFileSize) {
        throw new Error(`File too large: ${stats.size} bytes (max: ${this.maxFileSize})`);
      }

      const content = await fsPromises.readFile(targetPath);
      
      // Detect if binary by checking for null bytes in first 8KB
      const sample = content.slice(0, 8192);
      const isBinary = sample.includes(0);
      
      return {
        content: isBinary ? content.toString('base64') : content.toString('utf8'),
        encoding: isBinary ? 'base64' : 'utf8',
        mimeType: this.getMimeType(targetPath),
        size: stats.size
      };
    } catch (error) {
      if (error.code === 'ENOENT') {
        throw new Error('File not found');
      }
      if (error.code === 'EACCES') {
        throw new Error('Access denied');
      }
      if (error.code === 'EISDIR') {
        throw new Error('Path is a directory');
      }
      throw error;
    }
  }

  /**
   * Write file contents
   */
  async writeFile(params) {
    const targetPath = this.validatePath(params.path);
    const { content, encoding = 'utf8' } = params;

    if (content === undefined || content === null) {
      throw new Error('Content is required');
    }

    const buffer = encoding === 'base64' 
      ? Buffer.from(content, 'base64')
      : Buffer.from(content, 'utf8');

    if (buffer.length > this.maxFileSize) {
      throw new Error(`Content too large: ${buffer.length} bytes (max: ${this.maxFileSize})`);
    }

    try {
      // Create parent directories if needed
      const parentDir = path.dirname(targetPath);
      await fsPromises.mkdir(parentDir, { recursive: true });

      // Write file with secure permissions
      await fsPromises.writeFile(targetPath, buffer, { mode: 0o644 });
      
      const stats = await fsPromises.stat(targetPath);
      return { success: true, size: stats.size };
    } catch (error) {
      if (error.code === 'EACCES') {
        throw new Error('Access denied');
      }
      if (error.code === 'ENOSPC') {
        throw new Error('No space left on device');
      }
      throw new Error(`Failed to write file: ${error.message}`);
    }
  }

  /**
   * Delete a file
   */
  async deleteFile(params) {
    const targetPath = this.validatePath(params.path);

    try {
      const stats = await fsPromises.stat(targetPath);
      
      if (!stats.isFile()) {
        throw new NotAFileError();
      }

      await fsPromises.unlink(targetPath);
      return { success: true };
    } catch (error) {
      if (error.code === 'ENOENT') {
        throw new Error('File not found');
      }
      if (error.code === 'EACCES') {
        throw new AccessDeniedError();
      }
      // Re-throw custom errors
      if (error instanceof PathTraversalError || 
          error instanceof AccessDeniedError || 
          error instanceof NotAFileError) {
        throw error;
      }
      throw new Error(`Failed to delete file: ${error.message}`);
    }
  }

  /**
   * Create a directory
   */
  async createDirectory(params) {
    const targetPath = this.validatePath(params.path);

    try {
      await fsPromises.mkdir(targetPath, { recursive: false });
      return { success: true };
    } catch (error) {
      if (error.code === 'EEXIST') {
        throw new Error('Directory already exists');
      }
      if (error.code === 'EACCES') {
        throw new Error('Access denied');
      }
      throw new Error(`Failed to create directory: ${error.message}`);
    }
  }

  /**
   * Delete a directory (must be empty)
   */
  async deleteDirectory(params) {
    const targetPath = this.validatePath(params.path);

    try {
      const stats = await fsPromises.stat(targetPath);
      
      if (!stats.isDirectory()) {
        throw new Error('Not a directory');
      }

      // Check if directory is empty
      const entries = await fsPromises.readdir(targetPath);
      if (entries.length > 0) {
        throw new Error('Directory not empty');
      }

      await fsPromises.rmdir(targetPath);
      return { success: true };
    } catch (error) {
      if (error.code === 'ENOENT') {
        throw new Error('Directory not found');
      }
      if (error.code === 'EACCES') {
        throw new Error('Access denied');
      }
      throw error;
    }
  }

  /**
   * Get file metadata
   */
  async getFileInfo(params) {
    const targetPath = this.validatePath(params.path);

    try {
      const stats = await fsPromises.stat(targetPath);
      
      // Try to get permissions info
      let permissions = null;
      try {
        await fsPromises.access(targetPath, constants.R_OK);
        permissions = { readable: true };
        try {
          await fsPromises.access(targetPath, constants.W_OK);
          permissions.writable = true;
        } catch {
          permissions.writable = false;
        }
      } catch {
        permissions = { readable: false, writable: false };
      }

      return {
        name: path.basename(targetPath),
        type: stats.isDirectory() ? 'directory' : 'file',
        size: stats.size,
        modified: stats.mtimeMs,
        permissions
      };
    } catch (error) {
      if (error.code === 'ENOENT') {
        throw new Error('Path not found');
      }
      if (error.code === 'EACCES') {
        throw new Error('Access denied');
      }
      throw new Error(`Failed to get file info: ${error.message}`);
    }
  }

  /**
   * Simple MIME type detection based on extension
   */
  getMimeType(filePath) {
    const ext = path.extname(filePath).toLowerCase();
    const types = {
      '.txt': 'text/plain',
      '.html': 'text/html',
      '.css': 'text/css',
      '.js': 'application/javascript',
      '.json': 'application/json',
      '.png': 'image/png',
      '.jpg': 'image/jpeg',
      '.jpeg': 'image/jpeg',
      '.gif': 'image/gif',
      '.svg': 'image/svg+xml',
      '.pdf': 'application/pdf',
      '.zip': 'application/zip'
    };
    return types[ext] || 'application/octet-stream';
  }
}
