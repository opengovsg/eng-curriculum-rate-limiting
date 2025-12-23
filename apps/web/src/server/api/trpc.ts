/**
 * YOU PROBABLY DON'T NEED TO EDIT THIS FILE, UNLESS:
 * 1. You want to modify request context (see Part 1).
 * 2. You want to create a new middleware or type of procedure (see Part 3).
 *
 * TL;DR - This is where all the tRPC server stuff is created and plugged in. The pieces you will
 * need to use are documented accordingly near the end.
 */
import { initTRPC, TRPCError } from '@trpc/server'
// TODO: Import RateLimiterRes from 'rate-limiter-flexible' for error handling
import superjson from 'superjson'
import z, { ZodError } from 'zod'

import type { RateLimiterConfig } from '../modules/rate-limit/types'
import { env } from '~/env'
import { getSession } from '../session'

/**
 * 1. CONTEXT
 *
 * This section defines the "contexts" that are available in the backend API.
 *
 * These allow you to access things when processing a request, like the session, etc.
 *
 * This helper generates the "internals" for a tRPC context. The API handler and RSC clients each
 * wrap this and provides the required context.
 *
 * @see https://trpc.io/docs/server/context
 */
export const createTRPCContext = async ({
  headers,
  resHeaders,
}: {
  headers: Headers
  // resHeaders may not exist if called directly from RSC without an active request
  resHeaders?: Headers
}) => {
  const session = await getSession()
  return {
    headers,
    session,
    resHeaders,
  }
}

interface Meta {
  // Rate limit options for this procedure. If null, rate limiting is disabled.
  // Defaults to empty object, which applies default rate limiting.
  rateLimitOptions?: RateLimiterConfig | null
}

/**
 * 2. INITIALIZATION
 *
 * This is where the tRPC API is initialized, connecting the context and transformer. We also parse
 * ZodErrors so that you get typesafety on the frontend if your procedure fails due to validation
 * errors on the backend.
 */
const t = initTRPC
  .context<typeof createTRPCContext>()
  .meta<Meta>()
  .create({
    defaultMeta: {
      rateLimitOptions: {},
    },
    transformer: superjson,
    errorFormatter({ shape, error }) {
      return {
        ...shape,
        data: {
          ...shape.data,
          zodError:
            error.cause instanceof ZodError
              ? z.flattenError(error.cause)
              : null,
        },
      }
    },
  })

/**
 * Create a server-side caller.
 *
 * @see https://trpc.io/docs/server/server-side-calls
 */
export const createCallerFactory = t.createCallerFactory

/**
 * 3. ROUTER & PROCEDURE (THE IMPORTANT BIT)
 *
 * These are the pieces you use to build your tRPC API. You should import these a lot in the
 * "/src/server/api/routers" directory.
 */

/**
 * This is how you create new routers and sub-routers in your tRPC API.
 *
 * @see https://trpc.io/docs/router
 */
export const createTRPCRouter = t.router

/**
 * Middleware for timing procedure execution and adding an artificial delay in development.
 *
 * You can remove this if you don't like it, but it can help catch unwanted waterfalls by simulating
 * network latency that would occur in production but not in local development.
 */
const timingMiddleware = t.middleware(async ({ next, path }) => {
  const start = performance.now()

  const result = await next()

  const end = performance.now()

  const durationInMs = Math.round(end - start)

  console.log(`[TRPC] ${path} took ${durationInMs}ms to execute`)

  return result
})

/**
 * TODO: Implement the rate limiting middleware
 *
 * This middleware should:
 * 1. Check if rate limiting is disabled for this procedure (rateLimitOptions === null)
 *    - If disabled, call next() immediately
 * 2. Skip rate limiting in test environment (env.NODE_ENV === 'test')
 * 3. Create a fingerprint for rate limiting using:
 *    - IP address from request headers (use extractIpAddress)
 *    - User ID from session (if authenticated)
 * 4. Call checkRateLimit with the fingerprint and options
 * 5. Handle rate limit exceeded errors (RateLimiterRes):
 *    - Set 'Retry-After' header with seconds until reset
 *    - Set 'X-RateLimit-Reset' header with Unix timestamp
 *    - Throw TRPCError with code 'TOO_MANY_REQUESTS'
 * 6. Re-throw any other errors
 */
const rateLimitMiddleware = t.middleware(async ({ ctx: _ctx, next, meta }) => {
  // TODO: Extract rate limit options from meta (default to {} if undefined)
  const rateLimitOptions =
    meta?.rateLimitOptions === undefined ? {} : meta.rateLimitOptions

  // TODO: Skip rate limiting if options is null
  if (rateLimitOptions === null) {
    return next()
  }

  // TODO: Skip rate limiting in test environment
  if (env.NODE_ENV === 'test') {
    return next()
  }

  // TODO: Implement rate limit checking
  // 1. Create a fingerprint using createRateLimitFingerprint
  //    - Use extractIpAddress(ctx.headers) for the IP address
  //    - Use ctx.session.userId for the user ID
  // 2. Call checkRateLimit with the key and options
  // 3. Handle RateLimiterRes errors by setting headers and throwing TRPCError
  //    - Set ctx.resHeaders 'Retry-After' header with seconds until reset
  //    - Set ctx.resHeaders 'X-RateLimit-Reset' header with Unix timestamp
  //    - Throw TRPCError with code 'TOO_MANY_REQUESTS'
  //
  // Hint: Use try/catch to handle the RateLimiterRes error
  // The error returned from rate-limiter-flexible has a `msBeforeNext` property for calculating retry time

  return next()
})

const authMiddleware = t.middleware(({ ctx, next }) => {
  if (!ctx.session.userId) {
    ctx.session.destroy()
    throw new TRPCError({ code: 'UNAUTHORIZED' })
  }
  return next({
    ctx: {
      // infers the `session` as non-nullable
      session: { ...ctx.session, userId: ctx.session.userId },
    },
  })
})

const defaultProcedure = t.procedure
  .use(timingMiddleware)
  .use(rateLimitMiddleware)

/**
 * Public (unauthenticated) procedure
 *
 * This is the base piece you use to build new queries and mutations on your tRPC API. It does not
 * guarantee that a user querying is authorized, but you can still access user session data if they
 * are logged in.
 */
export const publicProcedure = defaultProcedure

/**
 * Protected (authenticated) procedure
 *
 * If you want a query or mutation to ONLY be accessible to logged in users, use this. It verifies
 * the session is valid and guarantees `ctx.session.user` is not null.
 *
 * @see https://trpc.io/docs/procedures
 */
export const protectedProcedure = defaultProcedure.use(authMiddleware)
