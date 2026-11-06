/**
 * services/sessionHandshakeService.js
 * In-memory concurrency and session handshake manager for Elementa LMS.
 * Coordinates real-time Grant / Deny authorization between active and incoming devices.
 */

const crypto = require('crypto');

class SessionHandshakeService {
    constructor() {
        // requestId -> requestData
        this.requests = new Map();
        
        // Track unique server boot state for reboot detection
        this.serverBootId = 'boot_' + crypto.randomBytes(8).toString('hex');
        this.serverBootTime = Date.now();

        // Auto-cleanup expired requests every 30 seconds
        this.cleanupTimer = setInterval(() => this.cleanupExpired(), 30000);
        if (this.cleanupTimer.unref) this.cleanupTimer.unref();
    }

    /**
     * Parses user-agent header into a human-readable device string.
     */
    parseDeviceInfo(userAgent = '', ip = '') {
        let browser = 'Web Browser';
        let os = 'Unknown OS';

        const ua = userAgent.toLowerCase();

        if (ua.includes('edg/')) browser = 'Edge';
        else if (ua.includes('chrome/')) browser = 'Chrome';
        else if (ua.includes('firefox/')) browser = 'Firefox';
        else if (ua.includes('safari/') && !ua.includes('chrome/')) browser = 'Safari';
        else if (ua.includes('opera/') || ua.includes('opr/')) browser = 'Opera';

        if (ua.includes('windows')) os = 'Windows';
        else if (ua.includes('android')) os = 'Android';
        else if (ua.includes('iphone') || ua.includes('ipad')) os = 'iOS';
        else if (ua.includes('macintosh') || ua.includes('mac os')) os = 'macOS';
        else if (ua.includes('linux')) os = 'Linux';

        const cleanIp = (ip || '').replace(/^.*:/, '') || '127.0.0.1';

        return {
            label: `${browser} on ${os}`,
            browser,
            os,
            ip: cleanIp
        };
    }

    /**
     * Creates a new pending concurrent login request when Device B attempts to log in.
     */
    createLoginRequest({ userId, userEmail, userRole, newSessionId, ip, userAgent, authMethod = 'password' }) {
        // Invalidate any older pending requests for this user
        for (const [id, req] of this.requests.entries()) {
            if (Number(req.userId) === Number(userId) && req.status === 'pending') {
                req.status = 'cancelled';
            }
        }

        const requestId = 'req_' + crypto.randomBytes(12).toString('hex');
        const now = Date.now();
        const ttlMs = 60 * 1000; // 60 seconds TTL

        const deviceInfo = this.parseDeviceInfo(userAgent, ip);

        const requestData = {
            requestId,
            userId: Number(userId),
            userEmail,
            userRole,
            newSessionId,
            deviceInfo,
            authMethod,
            status: 'pending', // 'pending' | 'granted' | 'denied' | 'expired' | 'cancelled'
            createdAt: now,
            expiresAt: now + ttlMs
        };

        this.requests.set(requestId, requestData);
        return requestData;
    }

    /**
     * Retrieves any currently pending request for an active user on Device A.
     */
    getPendingRequestForUser(userId) {
        const now = Date.now();
        for (const req of this.requests.values()) {
            if (Number(req.userId) === Number(userId)) {
                if (req.status === 'pending') {
                    if (now > req.expiresAt) {
                        req.status = 'expired';
                        continue;
                    }
                    return req;
                }
            }
        }
        return null;
    }

    /**
     * Gets a request by its requestId.
     */
    getRequest(requestId) {
        const req = this.requests.get(requestId);
        if (!req) return null;

        if (req.status === 'pending' && Date.now() > req.expiresAt) {
            req.status = 'expired';
        }
        return req;
    }

    /**
     * Resolves a pending login request when Device A clicks Grant or Deny.
     */
    resolveRequest(requestId, decision, actingUserId) {
        const req = this.getRequest(requestId);
        if (!req) {
            return { success: false, error: 'Request not found or already closed' };
        }

        if (req.status !== 'pending') {
            return { success: false, error: `Request already ${req.status}` };
        }

        if (Number(actingUserId) !== Number(req.userId)) {
            return { success: false, error: 'Unauthorized: User mismatch' };
        }

        if (decision === 'grant') {
            req.status = 'granted';
            req.resolvedAt = Date.now();
            return { success: true, status: 'granted' };
        } else if (decision === 'deny') {
            req.status = 'denied';
            req.resolvedAt = Date.now();
            return { success: true, status: 'denied' };
        } else {
            return { success: false, error: 'Invalid decision' };
        }
    }

    /**
     * Allows Device B to cancel their pending request.
     */
    cancelRequest(requestId) {
        const req = this.getRequest(requestId);
        if (req && req.status === 'pending') {
            req.status = 'cancelled';
            return true;
        }
        return false;
    }

    /**
     * Periodic cleanup of expired requests.
     */
    cleanupExpired() {
        const now = Date.now();
        for (const [id, req] of this.requests.entries()) {
            // Remove records older than 5 minutes to keep memory clean
            if (now > req.expiresAt + 5 * 60 * 1000) {
                this.requests.delete(id);
            }
        }
    }
}

module.exports = new SessionHandshakeService();

