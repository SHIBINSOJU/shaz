const TRANSIENT_PATTERNS = /ConnectTimeout|Connect Timeout|ETIMEDOUT|ECONNRESET|ECONNREFUSED|EAI_AGAIN|EPIPE|socket hang up|RequestTimeout|Internal Server Error|Bad Gateway|Service Unavailable|Gateway Timeout|Opening handshake has timed out/i;
const TRANSIENT_CODES = new Set(['ETIMEDOUT', 'ECONNRESET', 'ECONNREFUSED', 'EAI_AGAIN', 'EPIPE', 'UNDICI_CONNECT_TIMEOUT', 'UNDICI_SOCKET_TIMEOUT']);

function isTransientError(error) {
    if (!error) return false;
    if (typeof error.status === 'number' && error.status >= 500) return true;
    if (typeof error.code === 'string' && TRANSIENT_CODES.has(error.code)) return true;
    return TRANSIENT_PATTERNS.test(error.message || '');
}

/**
 * Retries an async operation only for transient network/server errors.
 * Permanent errors (bad permissions, invalid form body, ...) fail immediately.
 */
async function withRetry(fn, { attempts = 3, delayMs = 1500, onRetry = null } = {}) {
    let lastError;
    for (let attempt = 1; attempt <= attempts; attempt++) {
        try {
            return await fn(attempt);
        } catch (error) {
            lastError = error;
            if (attempt === attempts || !isTransientError(error)) throw error;
            if (onRetry) onRetry(attempt, error);
            await new Promise(resolve => setTimeout(resolve, delayMs * attempt));
        }
    }
    throw lastError;
}

module.exports = { withRetry, isTransientError };
