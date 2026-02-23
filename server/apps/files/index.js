import { FileService } from '../../services/files.js';

/**
 * Files app for HomeChannel
 * Wraps FileService as an app module with async entry point
 */

/**
 * Async entry point for the files app
 * @param {object} context - App context from server
 * @param {object} context.config - App-specific configuration
 * @param {object} context.channel - Datachannel for this app
 * @returns {object} App instance with message handler
 */
export async function run(context) {
  const config = context.config || {};
  const fileService = new FileService(config);

  return {
    /**
     * Handle incoming message on the app channel
     * @param {object} message - Parsed JSON message
     * @returns {object} Response object
     */
    async handleMessage(message) {
      const { requestId, operation, params } = message;

      if (!requestId) {
        return { requestId: null, success: false, error: 'Missing requestId' };
      }

      if (!operation) {
        return { requestId, success: false, error: 'Missing operation' };
      }

      if (typeof fileService[operation] !== 'function' || operation.startsWith('_') || operation === 'constructor') {
        return { requestId, success: false, error: `Unknown operation: ${operation}` };
      }

      try {
        const result = await fileService[operation](params || {});
        return { requestId, success: true, result };
      } catch (error) {
        return { requestId, success: false, error: error.message || 'Operation failed' };
      }
    }
  };
}
