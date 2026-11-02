import { generateKeyPairSync, randomBytes, sign } from 'node:crypto';

/**
 * A self-signed certificate for `localhost` and 127.0.0.1, made in the test with node:crypto (an
 * ECDSA P-256 key, DER written by hand), so that no key is kept in the repository. A test HTTPS
 * server presents it, and a client given it as `ca` trusts it.
 */
export function selfSignedCert(): { cert: string; key: string } {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const length = (n: number) => {
    if (n < 0x80) return Buffer.from([n]);
    const bytes: number[] = [];
    for (let v = n; v > 0; v >>= 8) bytes.unshift(v & 0xff);
    return Buffer.from([0x80 | bytes.length, ...bytes]);
  };
  const tlv = (tag: number, ...parts: Buffer[]) => {
    const body = Buffer.concat(parts);
    return Buffer.concat([Buffer.from([tag]), length(body.length), body]);
  };
  const seq = (...parts: Buffer[]) => tlv(0x30, ...parts);
  const oid = (dotted: string) => {
    const [a = 0, b = 0, ...rest] = dotted.split('.').map(Number);
    const bytes = [40 * a + b];
    for (const part of rest) {
      const enc = [part & 0x7f];
      for (let v = part >> 7; v > 0; v >>= 7) enc.unshift((v & 0x7f) | 0x80);
      bytes.push(...enc);
    }
    return tlv(0x06, Buffer.from(bytes));
  };
  const time = (d: Date) =>
    tlv(0x17, Buffer.from(`${d.toISOString().replace(/[-:T]/g, '').slice(2, 14)}Z`));
  const serial = randomBytes(8);
  serial[0] = (serial[0] ?? 0) & 0x7f;
  const ecdsaSha256 = seq(oid('1.2.840.10045.4.3.2'));
  const name = tlv(0x31, seq(oid('2.5.4.3'), tlv(0x0c, Buffer.from('localhost'))));
  const now = Date.now();
  const tbs = seq(
    tlv(0xa0, tlv(0x02, Buffer.from([2]))),
    tlv(0x02, serial),
    ecdsaSha256,
    seq(name),
    seq(time(new Date(now - 86_400_000)), time(new Date(now + 86_400_000))),
    seq(name),
    publicKey.export({ type: 'spki', format: 'der' }),
    tlv(
      0xa3,
      seq(
        seq(
          oid('2.5.29.17'),
          tlv(
            0x04,
            seq(tlv(0x82, Buffer.from('localhost')), tlv(0x87, Buffer.from([127, 0, 0, 1]))),
          ),
        ),
      ),
    ),
  );
  const signature = sign('sha256', tbs, privateKey);
  const der = seq(tbs, ecdsaSha256, tlv(0x03, Buffer.concat([Buffer.from([0]), signature])));
  const lines = der.toString('base64').match(/.{1,64}/g) ?? [];
  return {
    cert: `-----BEGIN CERTIFICATE-----\n${lines.join('\n')}\n-----END CERTIFICATE-----\n`,
    key: privateKey.export({ type: 'pkcs8', format: 'pem' }) as string,
  };
}
