# Production deployment

- Website: https://fantasy-bench.vercel.app
- Vercel project: https://vercel.com/zach-s-projects/fantasy-bench
- Vercel workspace: **Zach's Projects** (`zach-s-projects`)
- Convex production: `combative-gecko-193`
- Convex development: `tidy-peacock-243`

## Environment variables

Vercel production has `NEXT_PUBLIC_CONVEX_URL` and
`NEXT_PUBLIC_CONVEX_SITE_URL` pointing to the production Convex deployment.
Vercel preview and development use the development Convex deployment.

Convex production has separate `JWT_PRIVATE_KEY`, `JWKS`, and
`BYOK_ENCRYPTION_KEY` values. `SITE_URL` is the website URL above. These secrets
belong on Convex, not in the frontend or source control.

The following credentials were intentionally deferred at launch:

- `AI_GATEWAY_API_KEY`: platform-funded AI features.
- `AUTH_RESEND_KEY` (or `RESEND_API_KEY`) and `AUTH_EMAIL_FROM`: password-reset
  email delivery. The sender must be verified in Resend.

Set these in the **production** Convex deployment's environment settings.
Do not copy development flags such as `INGEST_DISABLED`, `RUN_DISPATCH=skip`,
or `BYOK_ALLOW_UNVERIFIED=1` to production.

## Deploying updates

Deploy the backend before the frontend when backend functions change:

```sh
npx convex deploy
npx vercel deploy --prod --yes --scope zach-s-projects
```

The initial release was deployed from the local workspace through the CLI.
The project is not configured for automatic deployments from Git.
`vercel.json` selects Next.js and the verified webpack production build.
Vercel uses Node.js 24. Local environment files and QA artifacts are excluded
by `.vercelignore`.

## Launch verification (September 9, 2026)

- Vercel production deployment reached `READY`; compilation, TypeScript,
  and static-page generation passed.
- Home, league entry, login, and signup routes returned HTTP 200.
- Browser navigation to leagues redirected an anonymous visitor to login;
  an invalid login displayed the expected error.
- The production authentication JWKS endpoint returned HTTP 200 with one key.
- Initial 2026 Week 1 ingestion loaded 3,230 players, 272 games, 3,227
  projections, 209 injury records, and 356 ownership records.
- No QA users or leagues were copied into production.
