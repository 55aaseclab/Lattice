import path from "node:path";
import { fileURLToPath } from "node:url";

const SLOW_IMAGE_DELAY_MS = 700;
const SLOW_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

/**
 * Fixture-only Vite plugin + define: the slow image resolves after a fixed
 * delay (so the E2E can prove inspection does not publish before decode
 * settles) and the hung image never responds at all (so decode stays pending
 * until the readiness deadline turns it into a ready-timeout naming the
 * image). The define flips the "stable" deck's title when FIXTURE_VARIANT=b,
 * giving the visual-regression tests a deterministic visible mutation.
 */
export default {
  define: {
    __FIXTURE_VARIANT__: JSON.stringify(process.env.FIXTURE_VARIANT ?? "a"),
  },
  plugins: [
    {
      name: "inspect-fixture-image-timing",
      configureServer(server) {
        server.middlewares.use((req, res, next) => {
          const url = (req.url ?? "").split("?")[0];
          if (url === "/decks/slow-image/assets/slow.png") {
            const timer = setTimeout(() => {
              res.setHeader("Content-Type", "image/png");
              res.setHeader("Content-Length", String(SLOW_PNG.length));
              res.end(SLOW_PNG);
            }, SLOW_IMAGE_DELAY_MS);
            res.on("close", () => clearTimeout(timer));
            return;
          }
          if (url === "/decks/hung-image/assets/hung.png") {
            return; // intentionally never respond and never call next()
          }
          next();
        });
      },
    },
  ],
};
