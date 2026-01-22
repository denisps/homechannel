/**
 * WebRTC connection handler for server
 * Manages peer connections and datachannel communication
 */

export class WebRTCPeer {
  constructor(options = {}) {
    this.pc = null;
    this.dataChannel = null;
    this.iceCandidates = [];
    this.handlers = new Map();
    this.onAnswer = options.onAnswer || null;
    this.serviceRouter = options.serviceRouter || null;
  }

  /**
   * Handle incoming SDP offer from client
   */
  async handleOffer(sdpOffer) {
    try {
      // Note: In Node.js environment, we need a WebRTC implementation
      // This is a stub that shows the structure
      // In production, use a library like webtc or wrtc
      
      console.log('Received SDP offer');
      
      // This would be implemented with actual WebRTC library in Node.js
      // For now, this is a placeholder
      if (this.handlers.has('offer-received')) {
        this.handlers.get('offer-received')(sdpOffer);
      }
    } catch (error) {
      console.error('Error handling offer:', error.message);
      throw error;
    }
  }

  /**
   * Create SDP answer
   */
  async createAnswer(sdpOffer) {
    try {
      // Placeholder for actual WebRTC answer creation
      // This would create a real answer with actual WebRTC implementation
      console.log('Creating answer for offer');
      
      // For testing purposes, return a mock answer
      return 'mock-answer-sdp';
    } catch (error) {
      console.error('Error creating answer:', error.message);
      throw error;
    }
  }

  /**
   * Add ICE candidate
   */
  addICECandidate(candidate) {
    try {
      this.iceCandidates.push(candidate);
      console.log('Added ICE candidate');
    } catch (error) {
      console.error('Error adding ICE candidate:', error.message);
      throw error;
    }
  }

  /**
   * Register event handler
   */
  on(event, handler) {
    this.handlers.set(event, handler);
  }

  /**
   * Get gathered ICE candidates
   */
  getICECandidates() {
    return this.iceCandidates;
  }

  /**
   * Handle incoming message from datachannel
   */
  async handleDataChannelMessage(message) {
    let parsedMessage;
    
    try {
      parsedMessage = typeof message === 'string' ? JSON.parse(message) : message;
    } catch (error) {
      return {
        requestId: null,
        success: false,
        error: 'Invalid JSON format'
      };
    }

    if (!this.serviceRouter) {
      return {
        requestId: parsedMessage.requestId,
        success: false,
        error: 'Service router not configured'
      };
    }

    try {
      const response = await this.serviceRouter.handleMessage(parsedMessage);
      return response;
    } catch (error) {
      return {
        requestId: parsedMessage.requestId || null,
        success: false,
        error: 'Internal server error'
      };
    }
  }

  /**
   * Send message over datachannel
   */
  sendMessage(message) {
    if (this.dataChannel && this.dataChannel.readyState === 'open') {
      const json = JSON.stringify(message);
      this.dataChannel.send(json);
    } else {
      throw new Error('DataChannel not ready');
    }
  }

  /**
   * Close peer connection
   */
  close() {
    if (this.pc) {
      this.pc.close();
    }
    this.iceCandidates = [];
  }
}
