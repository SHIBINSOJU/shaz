const SMALL_CAPS = {
    a: 'ᴀ', b: 'ʙ', c: 'ᴄ', d: 'ᴅ', e: 'ᴇ', f: 'ꜰ', g: 'ɢ', h: 'ʜ', i: 'ɪ', j: 'ᴊ',
    k: 'ᴋ', l: 'ʟ', m: 'ᴍ', n: 'ɴ', o: 'ᴏ', p: 'ᴘ', q: 'Q', r: 'ʀ', s: 's', t: 'ᴛ',
    u: 'ᴜ', v: 'ᴠ', w: 'ᴡ', x: 'x', y: 'ʏ', z: 'z'
};

// Unicode pseudo-font: characters without a small-caps equivalent pass through unchanged.
function smallCaps(text) {
    return String(text ?? '')
        .split('')
        .map(ch => SMALL_CAPS[ch.toLowerCase()] ?? ch)
        .join('');
}

module.exports = { smallCaps };
