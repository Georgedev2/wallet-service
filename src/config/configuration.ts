import * as Joi from 'joi';

export interface Env {
  NODE_ENV: 'development' | 'test' | 'production';
  PORT: number;
  DATABASE_URL: string;
  TEST_DATABASE_URL?: string;
  DATABASE_SSL: boolean;
  JWT_SECRET: string;
  JWT_EXPIRES_IN: string;
  ADMIN_EMAIL?: string;
  ADMIN_PASSWORD?: string;
  ADMIN_PHONE: string;
  ADMIN_FULL_NAME: string;
}

export const envSchema = Joi.object<Env>({
  NODE_ENV: Joi.string().valid('development', 'test', 'production').default('development'),
  PORT: Joi.number().port().default(3600),
  DATABASE_URL: Joi.string()
    .uri({ scheme: ['postgres', 'postgresql'] })
    .required(),
  TEST_DATABASE_URL: Joi.string().uri({ scheme: ['postgres', 'postgresql'] }),
  DATABASE_SSL: Joi.boolean().default(false),
  JWT_SECRET: Joi.string().min(32).required(),
  JWT_EXPIRES_IN: Joi.string().default('15m'),
  ADMIN_EMAIL: Joi.string().email(),
  ADMIN_PASSWORD: Joi.string().min(8),
  // users.phone and users.full_name are NOT NULL, so the seeded admin needs them too.
  ADMIN_PHONE: Joi.string()
    .pattern(/^\+[1-9]\d{7,14}$/, 'E.164')
    .default('+2340000000000'),
  ADMIN_FULL_NAME: Joi.string().default('Administrator'),
})
  // Seeding needs both or neither; one without the other is a misconfiguration.
  .and('ADMIN_EMAIL', 'ADMIN_PASSWORD');

export const envValidationOptions: Joi.ValidationOptions = {
  allowUnknown: true,
  abortEarly: false,
};

/** For code that runs outside Nest (the migration runner). Throws on invalid env. */
export function validateEnv(raw: NodeJS.ProcessEnv): Env {
  const { error, value } = envSchema.validate(raw, envValidationOptions);
  if (error) {
    throw new Error(`Invalid environment: ${error.message}`);
  }
  return value;
}
