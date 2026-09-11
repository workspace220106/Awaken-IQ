// Small request-body validators. Each returns a cleaned value or throws HttpError(400).

class HttpError extends Error {
    constructor(status, message) {
        super(message);
        this.status = status;
    }
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function str(value, { name, max = 200, required = false, pattern = null } = {}) {
    if (value === undefined || value === null || value === '') {
        if (required) throw new HttpError(400, `${name} is required.`);
        return '';
    }
    if (typeof value !== 'string') throw new HttpError(400, `${name} must be text.`);
    const trimmed = value.trim();
    if (trimmed.length > max) throw new HttpError(400, `${name} must be at most ${max} characters.`);
    if (pattern && !pattern.test(trimmed)) throw new HttpError(400, `${name} is not valid.`);
    return trimmed;
}

function email(value, name = 'Email') {
    return str(value, { name, max: 254, required: true, pattern: EMAIL_RE }).toLowerCase();
}

function password(value) {
    if (typeof value !== 'string' || value.length < 8) {
        throw new HttpError(400, 'Password must be at least 8 characters.');
    }
    if (value.length > 128) throw new HttpError(400, 'Password is too long.');
    return value;
}

function bool(value) {
    return value === true || value === 'true' || value === 'on';
}

function intInRange(value, { name, min, max }) {
    const n = parseInt(value, 10);
    if (Number.isNaN(n) || n < min || n > max) {
        throw new HttpError(400, `${name} must be a whole number between ${min} and ${max}.`);
    }
    return n;
}

function idString(value, name = 'ID') {
    // Firestore doc ids we generate are UUIDs or digit strings; reject anything exotic.
    return str(value, { name, max: 64, required: true, pattern: /^[A-Za-z0-9_-]+$/ });
}

function optionalUrl(value, name = 'Link') {
    const s = str(value, { name, max: 2048 });
    if (!s) return '';
    let parsed;
    try {
        parsed = new URL(s);
    } catch {
        throw new HttpError(400, `${name} must be a valid URL.`);
    }
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
        throw new HttpError(400, `${name} must start with http:// or https://.`);
    }
    return parsed.toString();
}

// Extracts the numeric meeting id from a Zoom join link, or null.
function zoomMeetingNumber(link) {
    if (typeof link !== 'string') return null;
    const m = link.match(/\/j\/(\d{9,12})/);
    return m ? m[1] : null;
}

module.exports = { HttpError, str, email, password, bool, intInRange, idString, optionalUrl, zoomMeetingNumber };
