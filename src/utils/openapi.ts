import { OpenAPIHono } from '@hono/zod-openapi';

/**
 * Build an OpenAPIHono router whose request-validation failures are rendered
 * as the project's standard { error, code } shape (see `ErrorSchema`) instead
 * of zod-openapi's default `{ success, error: { name, message } }` body.
 *
 * The message is prefixed with the offending field path (e.g. `radius: ...`)
 * so callers can tell which parameter was rejected; the code is always
 * `INVALID_PARAM`, matching the manual checks this replaces.
 */
export function createApiRouter(): OpenAPIHono {
  return new OpenAPIHono({
    defaultHook: (result, c) => {
      if (!result.success) {
        const message = result.error.issues
          .map((issue) => `${issue.path.join('.') || 'request'}: ${issue.message}`)
          .join('; ');
        return c.json({ error: message, code: 'INVALID_PARAM' }, 400);
      }
    },
  });
}
