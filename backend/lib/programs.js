// Single source of truth for what can be bought and for how much.
// The frontend mirrors these for display only; the server never trusts a client-supplied price.

const GST_RATE = 0.18;

const PROGRAMS = {
    midbrain: { name: 'Midbrain Activation Workshop', duration: '12 Weeks', priceInr: 1000 },
    dmit: { name: 'DMIT Workshop', duration: '2 Sessions', priceInr: 1000 },
    qsr: { name: 'QSR Workshop', duration: '8 Weeks', priceInr: 1000 }
};

function getProgram(key) {
    if (typeof key !== 'string') return null;
    return PROGRAMS[key.toLowerCase()] || null;
}

// Total payable in paise (Razorpay's unit), GST inclusive.
function amountInPaise(programKey) {
    const program = getProgram(programKey);
    if (!program) return null;
    return Math.round(program.priceInr * (1 + GST_RATE) * 100);
}

module.exports = { PROGRAMS, GST_RATE, getProgram, amountInPaise };
