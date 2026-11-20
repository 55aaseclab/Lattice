import { z } from 'zod';
import { createBusinessSchema } from './schema-definition.mjs';
export const { idSchema, revisionSchema, nativeValueSchema, templateVarsSchema, nativeSlideSchema, editOperationSchema, inputs, OPERATIONS, NO_RESOURCE, DOCUMENT_WRITES, SNAPSHOT_OPERATIONS, KEYED_OPERATIONS, TOOL_DESCRIPTIONS } = createBusinessSchema(z);
