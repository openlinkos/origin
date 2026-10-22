import http from 'node:http';

export interface TestResponse {
  status: number;
  headers: http.IncomingHttpHeaders;
  text: string;
  // biome-ignore lint/suspicious/noExplicitAny: tests read arbitrary JSON
  json(): any;
  setCookies: string[];
}

/** A raw HTTP request with full control over headers, including Host. */
export function request(
  url: string,
  opts: { method?: string; headers?: Record<string, string>; body?: string | Buffer } = {},
): Promise<TestResponse> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      url,
      { method: opts.method ?? 'GET', headers: opts.headers },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          const setCookie = res.headers['set-cookie'];
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            text,
            json: () => JSON.parse(text),
            setCookies: Array.isArray(setCookie) ? setCookie : setCookie ? [setCookie] : [],
          });
        });
        res.on('error', reject);
      },
    );
    req.on('error', reject);
    if (opts.body !== undefined) req.end(opts.body);
    else req.end();
  });
}

/**
 * A minimal browser: a cookie jar, same-origin Origin headers on POST, and the CSRF token of the
 * last page it saw.
 */
export class Browser {
  readonly jar = new Map<string, string>();
  csrf = '';

  constructor(
    readonly base: string,
    readonly origin = base,
  ) {}

  private cookieHeader(): Record<string, string> {
    if (this.jar.size === 0) return {};
    return { Cookie: [...this.jar].map(([k, v]) => `${k}=${v}`).join('; ') };
  }

  private remember(res: TestResponse): TestResponse {
    for (const c of res.setCookies) {
      const [pair = ''] = c.split(';');
      const eq = pair.indexOf('=');
      const name = pair.slice(0, eq).trim();
      const value = pair.slice(eq + 1).trim();
      if (/max-age=0/i.test(c) || value === '') this.jar.delete(name);
      else this.jar.set(name, value);
    }
    const csrf = /name="_csrf" value="([^"]+)"/.exec(res.text)?.[1];
    if (csrf) this.csrf = csrf;
    return res;
  }

  async get(path: string, headers: Record<string, string> = {}): Promise<TestResponse> {
    return this.remember(
      await request(`${this.base}${path}`, { headers: { ...this.cookieHeader(), ...headers } }),
    );
  }

  /** Submit a form, adding the CSRF token unless `_csrf` is given. */
  async post(
    path: string,
    form: Record<string, string>,
    headers: Record<string, string> = {},
  ): Promise<TestResponse> {
    const body = new URLSearchParams({ _csrf: this.csrf, ...form }).toString();
    return this.remember(
      await request(`${this.base}${path}`, {
        method: 'POST',
        headers: {
          ...this.cookieHeader(),
          Origin: this.origin,
          'Sec-Fetch-Site': 'same-origin',
          'Content-Type': 'application/x-www-form-urlencoded',
          ...headers,
        },
        body,
      }),
    );
  }

  /** Call the JSON API, sending the CSRF token as a header. */
  async api(
    method: 'GET' | 'POST',
    path: string,
    body?: unknown,
    headers: Record<string, string> = {},
  ): Promise<TestResponse> {
    return this.remember(
      await request(`${this.base}/admin/api/${path}`, {
        method,
        headers: {
          ...this.cookieHeader(),
          ...(method === 'POST'
            ? {
                Origin: this.origin,
                'Content-Type': 'application/json',
                'X-CSRF-Token': this.csrf,
              }
            : {}),
          ...headers,
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      }),
    );
  }

  /** Sign in through the login form. */
  async login(password: string): Promise<TestResponse> {
    const res = await this.post('/admin/login', { password, next: '/admin/' });
    await this.get('/admin/');
    return res;
  }
}
