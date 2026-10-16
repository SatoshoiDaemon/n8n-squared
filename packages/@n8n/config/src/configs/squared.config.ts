import { z } from 'zod';

import { Config, Env } from '../decorators';

export const squaredRuntimeProfileSchema = z.enum(['standard', 'lightweight', 'developer']);
export type SquaredRuntimeProfile = z.infer<typeof squaredRuntimeProfileSchema>;

@Config
export class SquaredConfig {
	/** Selects the Squared runtime profile. Resource optimizations require measured evidence. */
	@Env('SQUARED_RUNTIME_PROFILE', squaredRuntimeProfileSchema)
	runtimeProfile: SquaredRuntimeProfile = 'standard';
}
