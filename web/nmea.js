// Parses NMEA 0183 sentences from USB GPS receivers (GGA and RMC).
function nmeaChecksumOk(line) {
  const m = /^\$([^*]+)\*([0-9A-F]{2})/i.exec(line);
  if (!m) return false;
  let c = 0;
  for (const ch of m[1]) c ^= ch.charCodeAt(0);
  return c === parseInt(m[2], 16);
}
function nmeaDeg(v, hemi) {
  if (!v) return null;
  const dot = v.indexOf('.');
  const degLen = dot - 2;
  const deg = Number(v.slice(0, degLen)) + Number(v.slice(degLen)) / 60;
  return /[SW]/i.test(hemi) ? -deg : deg;
}
export function parseNmea(line) {
  if (!nmeaChecksumOk(line)) return null;
  const f = line.split('*')[0].split(',');
  const type = f[0].slice(3);
  if (type === 'GGA') {
    if (!Number(f[6])) return { fix: false };
    return { fix: true, lat: nmeaDeg(f[2], f[3]), lon: nmeaDeg(f[4], f[5]), sats: Number(f[7]) || null, hdop: Number(f[8]) || null };
  }
  if (type === 'RMC') {
    if (f[2] !== 'A') return { fix: false };
    return { fix: true, lat: nmeaDeg(f[3], f[4]), lon: nmeaDeg(f[5], f[6]) };
  }
  return null;
}

