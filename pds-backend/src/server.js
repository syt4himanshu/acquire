const path = require("path");
const dotenv = require("dotenv");

// Resolve .env from project root (pds-backend/) regardless of cwd
dotenv.config({ path: path.resolve(__dirname, "../.env") });

const app = require("./app");
const logger = require("./config/logger");
const pool = require("./config/db");
const { startEntitlementCron } = require("./jobs/entitlementCron");
const { startOtpCleanupCron } = require("./jobs/otpCleanup");
const { startAnomalyDetectionCron } = require("./jobs/anomalyDetectionCron");
const { startAnchorRetryCron } = require("./jobs/anchorRetryCron");
const { startAnomalyRulesCron } = require("./jobs/anomalyRulesCron");
const { attachWebSocketServers } = require("./ws/attachSockets");

const VALID_NODE_ENVS = ["development", "production", "test"];

// Only these variables are mandatory for local startup.
// Twilio is optional for local development.
const REQUIRED_ENV_VARS = [
  "JWT_SECRET",
  "NODE_ENV",
];

const PORT = Number(process.env.PORT) || 5000;
const HOST = process.env.HOST || "0.0.0.0";
let server;

const redactDatabaseUrl = (url) => {
  if (!url) return url;
  return url.replace(/:\/\/([^:]+):([^@]+)@/, "://$1:****@");
};

const validateEnvironment = () => {
  const errors = [];

  const missingVars = REQUIRED_ENV_VARS.filter(
    (name) => !process.env[name] || process.env[name].trim() === "",
  );

  const nodeEnv = process.env.NODE_ENV;

  if (!nodeEnv) {
    errors.push(
      "NODE_ENV is required and must be one of production, development, test",
    );
  } else if (!VALID_NODE_ENVS.includes(nodeEnv)) {
    errors.push(
      `NODE_ENV must be one of ${VALID_NODE_ENVS.join(", ")}, got '${nodeEnv}'`,
    );
  }

  const dbVarName =
    nodeEnv === "test" ? "TEST_DATABASE_URL" : "DATABASE_URL";

  if (!process.env[dbVarName] || process.env[dbVarName].trim() === "") {
    missingVars.push(dbVarName);
  }

  if (missingVars.length > 0) {
    errors.push(
      `Missing required environment variables: ${Array.from(
        new Set(missingVars),
      ).join(", ")}`,
    );
  }

  if (errors.length) {
    throw new Error(errors.join(" | "));
  }
};

const verifyDatabaseConnection = async () => {
  try {
    const result = await pool.query("SELECT 1 AS result");

    logger.info("PostgreSQL connectivity verified", {
      nodeEnv: process.env.NODE_ENV,
      databaseUrl: redactDatabaseUrl(process.env.DATABASE_URL),
      result: result.rows[0],
    });
  } catch (error) {
    logger.error("PostgreSQL connectivity check failed", {
      message: error.message,
      stack: error.stack,
    });

    throw new Error(
      `Database connectivity check failed: ${error.message}`,
    );
  }
};

const ensureDatabaseGuards = async () => {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS qr_sessions (
      session_id VARCHAR(150) PRIMARY KEY,
      ration_card_id UUID NOT NULL REFERENCES ration_cards(id) ON DELETE CASCADE,
      shop_id UUID NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
      issued_to_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
      expires_at TIMESTAMP NOT NULL,
      is_used BOOLEAN NOT NULL DEFAULT false,
      created_at TIMESTAMP NOT NULL DEFAULT NOW(),
      used_at TIMESTAMP
    );
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_qr_sessions_ration_card_id
      ON qr_sessions(ration_card_id);
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_qr_sessions_shop_id
      ON qr_sessions(shop_id);
  `);

  await pool.query(`
    CREATE OR REPLACE FUNCTION prevent_admin_user_delete()
    RETURNS trigger
    AS $$
    BEGIN
      IF OLD.role = 'admin' OR LOWER(COALESCE(OLD.email, '')) = 'admin@pds.gov' THEN
        RAISE EXCEPTION 'Admin users cannot be deleted';
      END IF;

      RETURN OLD;
    END;
    $$ LANGUAGE plpgsql;
  `);

  await pool.query(`
    DROP TRIGGER IF EXISTS trg_prevent_admin_user_delete ON users;

    CREATE TRIGGER trg_prevent_admin_user_delete
    BEFORE DELETE ON users
    FOR EACH ROW
    EXECUTE FUNCTION prevent_admin_user_delete();
  `);
};

const shutdown = async (reason) => {
  if (reason instanceof Error) {
    logger.error("Shutdown triggered by error", {
      message: reason.message,
      stack: reason.stack,
    });
  } else {
    logger.info("Shutdown signal received", { reason });
  }

  if (server) {
    logger.info("Closing HTTP server");

    server.close((err) => {
      if (err) {
        logger.error("HTTP server close failed", {
          message: err.message,
          stack: err.stack,
        });
      }
    });
  }

  try {
    logger.info("Closing database pool");

    await pool.end();

    logger.info("Database pool closed");
  } catch (error) {
    logger.error("Failed to close database pool", {
      message: error.message,
      stack: error.stack,
    });
  } finally {
    process.exit(reason instanceof Error ? 1 : 0);
  }
};

process.on("uncaughtException", (error) => {
  logger.error("Uncaught exception", {
    message: error.message,
    stack: error.stack,
  });

  shutdown(error);
});

process.on("unhandledRejection", (reason) => {
  logger.error("Unhandled promise rejection", {
    reason: reason instanceof Error ? reason.message : reason,
    stack: reason instanceof Error ? reason.stack : undefined,
  });

  shutdown(new Error("Unhandled promise rejection"));
});

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

const startServer = async () => {
  try {
    validateEnvironment();

    await verifyDatabaseConnection();

    await ensureDatabaseGuards();

    startEntitlementCron();
    startOtpCleanupCron();
    startAnomalyDetectionCron();
    startAnchorRetryCron();
    startAnomalyRulesCron();

    // Enhanced startup diagnostics
    logger.info("===== BACKEND STARTUP DIAGNOSTICS =====");

    logger.info("Server Configuration", {
      NODE_ENV: process.env.NODE_ENV,
      PORT: PORT,
      HOST: HOST,
      JWT_SECRET_SET: !!process.env.JWT_SECRET,
      CORS_ORIGINS: process.env.CORS_ORIGINS || "not set",
      CORS_ALLOW_ALL_DEV_ORIGINS:
        process.env.CORS_ALLOW_ALL_DEV_ORIGINS ||
        "true (default)",
      DATABASE_URL_HOST: process.env.DATABASE_URL
        ? new URL(process.env.DATABASE_URL).hostname
        : "not set",
    });

    logger.info("========================================");

    server = app.listen(PORT, HOST, () => {
      logger.info(`Server running on ${HOST}:${PORT}`);

      logger.info("Available Endpoints:", {
        health: `http://${HOST}:${PORT}/health`,
        debugCors: `http://${HOST}:${PORT}/debug/cors`,
        apiInfo: `http://${HOST}:${PORT}/api-info`,
        authLogin: `http://${HOST}:${PORT}/auth/login (POST)`,
      });

      if (process.env.NODE_ENV !== "production") {
        logger.info(`Local access: http://localhost:${PORT}`);
      }
    });

    attachWebSocketServers(server);

    server.on("error", (error) => {
      if (error.code === "EADDRINUSE") {
        logger.error(
          `Port ${PORT} is already in use. Set a different PORT in your environment and restart.`,
          {
            port: PORT,
          },
        );

        process.exit(1);
      }

      logger.error("Server failed to start", {
        message: error.message,
        stack: error.stack,
      });

      process.exit(1);
    });
  } catch (error) {
    logger.error("Failed to initialize server", {
      message: error.message,
      stack: error.stack,
    });

    process.exit(1);
  }
};

if (process.env.NODE_ENV !== "test") {
  startServer();
}

module.exports = {
  validateEnvironment,
  startServer,
};