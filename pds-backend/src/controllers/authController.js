const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const twilio = require('twilio');
const pool = require('../config/db');
const logger = require('../config/logger');

const twilioClient =
  process.env.TWILIO_ACCOUNT_SID &&
  process.env.TWILIO_AUTH_TOKEN &&
  process.env.TWILIO_ACCOUNT_SID.startsWith('AC')
    ? twilio(
        process.env.TWILIO_ACCOUNT_SID,
        process.env.TWILIO_AUTH_TOKEN,
      )
    : null;

// ============================================================
// DEVELOPMENT OTP STORAGE
// ============================================================
// Used only when DEV_OTP_ENABLED=true.
// OTPs are kept in memory and expire after 5 minutes.
const developmentOtps = new Map();

const signToken = (payload) =>
  jwt.sign(payload, process.env.JWT_SECRET, {
    expiresIn: process.env.JWT_EXPIRES_IN || '7d',
  });

const normalizeIndianMobile = (value = '') => {
  const digits = String(value).replace(/\D/g, '');

  if (digits.length === 10) {
    return `+91${digits}`;
  }

  if (digits.length === 12 && digits.startsWith('91')) {
    return `+${digits}`;
  }

  return null;
};

const buildMobileCandidates = (normalizedMobile) => {
  const digits = String(normalizedMobile || '').replace(/\D/g, '');

  if (digits.length !== 12 || !digits.startsWith('91')) {
    return [];
  }

  const lastTen = digits.slice(2);

  return [
    normalizedMobile,
    `91${lastTen}`,
    lastTen,
  ];
};

const hasTwilioConfig = () =>
  Boolean(
    process.env.TWILIO_ACCOUNT_SID &&
    process.env.TWILIO_AUTH_TOKEN &&
    process.env.TWILIO_SERVICE_SID,
  );

const INVALID_OTP_TWILIO_CODES = new Set([
  20404,
  60200,
  60202,
  60203,
  60212,
  60213,
]);

const mapTwilioError = (error, fallbackMessage) => {
  if (!error || !error.code) {
    return null;
  }

  const numericCode = Number(error.code);

  if (INVALID_OTP_TWILIO_CODES.has(numericCode)) {
    return {
      status: 401,
      payload: {
        error: 'Invalid OTP',
      },
    };
  }

  return {
    status: error.status || 502,
    payload: {
      error: fallbackMessage,
    },
  };
};

// ============================================================
// ADMIN / EMAIL LOGIN
// ============================================================

const login = async (req, res, next) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({
        error: 'Email and password are required',
      });
    }

    const result = await pool.query(
      `SELECT id, role, email, password_hash
       FROM users
       WHERE email = $1
       LIMIT 1`,
      [email],
    );

    if (result.rows.length === 0) {
      logger.warn('Login failed', {
        email,
      });

      return res.status(401).json({
        error: 'Invalid credentials',
      });
    }

    const user = result.rows[0];

    const isPasswordValid = await bcrypt.compare(
      password,
      user.password_hash,
    );

    if (!isPasswordValid) {
      logger.warn('Login failed', {
        email,
      });

      return res.status(401).json({
        error: 'Invalid credentials',
      });
    }

    logger.info('Login success', {
      email,
      role: user.role,
    });

    const token = signToken({
      id: user.id,
      role: user.role,
      email: user.email,
    });

    return res.status(200).json({
      token,
      user: {
        id: user.id,
        role: user.role,
        email: user.email,
      },
    });
  } catch (error) {
    return next(error);
  }
};

// ============================================================
// SEND OTP
// ============================================================

const sendOtp = async (req, res, next) => {
  try {
    const normalizedMobile = normalizeIndianMobile(
      req.body.mobile,
    );

    if (!normalizedMobile) {
      return res.status(400).json({
        error: 'Mobile must be in format +91XXXXXXXXXX',
      });
    }

    // --------------------------------------------------------
    // Check whether beneficiary exists
    // --------------------------------------------------------

    const mobileCandidates =
      buildMobileCandidates(normalizedMobile);

    const result = await pool.query(
      `SELECT id
       FROM users
       WHERE role = 'beneficiary'
         AND mobile = ANY($1::text[])
       LIMIT 1`,
      [mobileCandidates],
    );

    if (result.rows.length === 0) {
      return res.status(404).json({
        error: 'Beneficiary not found',
      });
    }

    // ========================================================
    // DEVELOPMENT OTP MODE
    // ========================================================

    if (process.env.DEV_OTP_ENABLED === 'true') {
      const otp = Math.floor(
        100000 + Math.random() * 900000,
      ).toString();

      const expiresAt =
        Date.now() + 5 * 60 * 1000;

      developmentOtps.set(normalizedMobile, {
        otp,
        expiresAt,
      });

      console.log('');
      console.log('========================================');
      console.log('        DEVELOPMENT OTP');
      console.log('========================================');
      console.log(`Mobile : ${normalizedMobile}`);
      console.log(`OTP    : ${otp}`);
      console.log('Expires: 5 minutes');
      console.log('========================================');
      console.log('');

      logger.info('Development OTP generated', {
        mobile: normalizedMobile,
      });

      return res.status(200).json({
        message: 'OTP generated successfully',
      });
    }

    // ========================================================
    // NORMAL TWILIO MODE
    // ========================================================

    if (!hasTwilioConfig()) {
      logger.error(
        'Missing Twilio configuration for OTP send',
      );

      return res.status(500).json({
        error: 'OTP service is not configured',
      });
    }

    await twilioClient.verify.v2
      .services(process.env.TWILIO_SERVICE_SID)
      .verifications.create({
        to: normalizedMobile,
        channel: 'sms',
      });

    logger.info('OTP sent', {
      mobile: normalizedMobile,
    });

    return res.status(200).json({
      message: 'OTP sent successfully',
    });
  } catch (error) {
    const mapped = mapTwilioError(
      error,
      'Failed to send OTP',
    );

    if (mapped) {
      logger.warn('OTP send failed', {
        code: error.code,
        status: mapped.status,
      });

      return res
        .status(mapped.status)
        .json(mapped.payload);
    }

    return next(error);
  }
};

// ============================================================
// VERIFY OTP
// ============================================================

const verifyOtp = async (req, res, next) => {
  try {
    if (!process.env.JWT_SECRET) {
      logger.error(
        'Missing JWT_SECRET for OTP verify token signing',
      );

      return res.status(500).json({
        error: 'Auth token configuration is missing',
      });
    }

    const { otp } = req.body;

    const normalizedMobile =
      normalizeIndianMobile(req.body.mobile);

    if (!normalizedMobile || !otp) {
      return res.status(400).json({
        error: 'Mobile and otp are required',
      });
    }

    if (!/^\d{6}$/.test(String(otp).trim())) {
      return res.status(400).json({
        error: 'OTP must be a 6-digit code',
      });
    }

    // ========================================================
    // DEVELOPMENT OTP VERIFICATION
    // ========================================================

    if (process.env.DEV_OTP_ENABLED === 'true') {
      const storedOtp =
        developmentOtps.get(normalizedMobile);

      if (!storedOtp) {
        return res.status(401).json({
          error: 'OTP not found or expired',
        });
      }

      if (Date.now() > storedOtp.expiresAt) {
        developmentOtps.delete(normalizedMobile);

        return res.status(401).json({
          error: 'OTP expired',
        });
      }

      if (String(otp).trim() !== storedOtp.otp) {
        return res.status(401).json({
          error: 'Invalid OTP',
        });
      }

      // OTP can only be used once
      developmentOtps.delete(normalizedMobile);

      logger.info('Development OTP verified', {
        mobile: normalizedMobile,
      });
    } else {
      // ======================================================
      // NORMAL TWILIO VERIFICATION
      // ======================================================

      if (!hasTwilioConfig()) {
        logger.error(
          'Missing Twilio configuration for OTP verify',
        );

        return res.status(500).json({
          error: 'OTP service is not configured',
        });
      }

      const verification =
        await twilioClient.verify.v2
          .services(process.env.TWILIO_SERVICE_SID)
          .verificationChecks.create({
            to: normalizedMobile,
            code: otp,
          });

      if (verification.status !== 'approved') {
        return res.status(401).json({
          error: 'Invalid OTP',
        });
      }
    }

    // ========================================================
    // FIND BENEFICIARY
    // ========================================================

    const mobileCandidates =
      buildMobileCandidates(normalizedMobile);

    const result = await pool.query(
      `SELECT id, role, mobile
       FROM users
       WHERE role = 'beneficiary'
         AND mobile = ANY($1::text[])
       LIMIT 1`,
      [mobileCandidates],
    );

    if (result.rows.length === 0) {
      return res.status(404).json({
        error: 'User not found',
      });
    }

    const user = result.rows[0];

    logger.info('OTP verified', {
      mobile: normalizedMobile,
    });

    // ========================================================
    // CREATE JWT TOKEN
    // ========================================================

    const token = signToken({
      id: user.id,
      role: user.role,
      mobile: user.mobile,
    });

    return res.status(200).json({
      token,
      user: {
        id: user.id,
        role: user.role,
        mobile: user.mobile,
      },
    });
  } catch (error) {
    const mapped = mapTwilioError(
      error,
      'Failed to verify OTP',
    );

    if (mapped) {
      logger.warn('OTP verify failed', {
        code: error.code,
        status: mapped.status,
      });

      return res
        .status(mapped.status)
        .json(mapped.payload);
    }

    return next(error);
  }
};

// ============================================================
// EXPORT
// ============================================================

module.exports = {
  login,
  sendOtp,
  verifyOtp,
};