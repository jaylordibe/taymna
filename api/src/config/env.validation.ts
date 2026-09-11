import Joi from 'joi';

export const envValidationSchema = Joi.object({
  NODE_ENV: Joi.string()
    .valid('development', 'test', 'production')
    .default('development'),
  DATABASE_URL: Joi.string().uri().required(),
  JWT_SECRET: Joi.string().min(32).required(),
  PORT: Joi.number().port().default(3000),
  WEB_ORIGIN: Joi.string().default('*'),
  HEARTBEAT_TIMEOUT_SECONDS: Joi.number().positive().default(60),
  ADMIN_EMAIL: Joi.string().email().required(),
  ADMIN_PASSWORD: Joi.string().min(8).required(),
});
