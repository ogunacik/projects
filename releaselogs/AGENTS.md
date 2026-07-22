# Agent Instructions

## Build And Verification

- Build and redeploy this app through Docker Compose, not the host Node/npm toolchain:
  `docker compose up -d --build releaselogs`
- The app container uses the supported Node runtime. The host shell may have an older Node version, so host-side `npm run build` can fail on native Vite/Tailwind optional dependencies even when the Docker build is valid.
- For TypeScript-only checks, `npm run lint` is acceptable after dependencies are installed, but the final build verification should still be Docker Compose.
- After rebuilding, confirm the service is running with:
  `docker compose ps releaselogs`

## Local Runtime Notes

- The app is exposed at `https://localhost` and redirects plain HTTP to HTTPS.
- LDAP service names such as `ldap-server` resolve inside the Docker Compose network. Host-side LDAP scripts may fail DNS unless they use `localhost` and the exposed ports.
