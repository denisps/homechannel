import { FileService } from './files.js';

/**
 * Service Router for HomeChannel Server
 * Routes messages from datachannel to appropriate service
 */

export class ServiceRouter {
  constructor(config = {}) {
    this.services = {};
    this.config = config;
    
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
