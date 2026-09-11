const test = require('node:test');
const assert = require('node:assert/strict');

const { getProgram, amountInPaise, PROGRAMS } = require('../lib/programs');
const V = require('../lib/validate');

test('programs: every program prices to whole paise, GST inclusive', () => {
    for (const key of Object.keys(PROGRAMS)) {
        const paise = amountInPaise(key);
        assert.equal(paise, Math.round(PROGRAMS[key].priceInr * 1.18 * 100));
        assert.ok(Number.isInteger(paise) && paise >= 100);
    }
});

test('programs: unknown or non-string keys are rejected', () => {
    assert.equal(getProgram('free-course'), null);
    assert.equal(amountInPaise('free-course'), null);
    assert.equal(getProgram({ toString: () => 'dmit' }), null);
    assert.equal(getProgram('DMIT'), PROGRAMS.dmit); // case-insensitive
});

test('validate.email normalises and rejects junk', () => {
    assert.equal(V.email('  Parent@Example.COM '), 'parent@example.com');
    assert.throws(() => V.email('not-an-email'), (e) => e.status === 400);
    assert.throws(() => V.email(['a@b.co']), (e) => e.status === 400);
    assert.throws(() => V.email(''), (e) => e.status === 400);
});

test('validate.password enforces length bounds', () => {
    assert.equal(V.password('longenough'), 'longenough');
    assert.throws(() => V.password('short'), (e) => e.status === 400);
    assert.throws(() => V.password(12345678), (e) => e.status === 400);
    assert.throws(() => V.password('x'.repeat(129)), (e) => e.status === 400);
});

test('validate.str trims, bounds and pattern-checks', () => {
    assert.equal(V.str('  hi ', { name: 'x' }), 'hi');
    assert.equal(V.str(undefined, { name: 'x' }), '');
    assert.throws(() => V.str(undefined, { name: 'x', required: true }), /x is required/);
    assert.throws(() => V.str('a'.repeat(11), { name: 'x', max: 10 }), /at most 10/);
    assert.throws(() => V.str('<b>', { name: 'x', pattern: /^[a-z]+$/ }), /not valid/);
    assert.throws(() => V.str({}, { name: 'x' }), /must be text/);
});

test('validate.idString only accepts safe document ids', () => {
    assert.equal(V.idString('1721234567890'), '1721234567890');
    assert.equal(V.idString('3f2a-uuid_like'), '3f2a-uuid_like');
    assert.throws(() => V.idString('../users/x'), (e) => e.status === 400);
    assert.throws(() => V.idString(''), (e) => e.status === 400);
});

test('validate.optionalUrl only allows http(s)', () => {
    assert.equal(V.optionalUrl('https://zoom.us/j/123'), 'https://zoom.us/j/123');
    assert.equal(V.optionalUrl(''), '');
    assert.throws(() => V.optionalUrl('javascript:alert(1)'), (e) => e.status === 400);
    assert.throws(() => V.optionalUrl('zoom.us/j/123'), (e) => e.status === 400);
});

test('validate.intInRange', () => {
    assert.equal(V.intInRange('4', { name: 'r', min: 1, max: 5 }), 4);
    assert.throws(() => V.intInRange('9', { name: 'r', min: 1, max: 5 }), (e) => e.status === 400);
    assert.throws(() => V.intInRange('abc', { name: 'r', min: 1, max: 5 }), (e) => e.status === 400);
});

test('validate.zoomMeetingNumber extracts the meeting id from join links', () => {
    assert.equal(V.zoomMeetingNumber('https://us02web.zoom.us/j/81234567890?pwd=abc'), '81234567890');
    assert.equal(V.zoomMeetingNumber('https://zoom.us/j/123'), null);
    assert.equal(V.zoomMeetingNumber('https://meet.google.com/abc-defg-hij'), null);
    assert.equal(V.zoomMeetingNumber(null), null);
});
