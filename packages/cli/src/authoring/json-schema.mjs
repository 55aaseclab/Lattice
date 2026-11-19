// Discovery derives its constraints from the same pinned Zod schemas that enforce writes.
export function describeInput(schema, { node, active = new Set(), reference = '#/$defs/node' } = {}) {
  if (schema === node && active.has(node)) return { $ref: reference };
  const next = new Set(active); next.add(schema);
  const definition = schema._def;
  const describe = child => describeInput(child, { node, active: next, reference });
  switch (definition.typeName) {
    case 'ZodOptional': return describe(definition.innerType);
    case 'ZodLazy': return describe(definition.getter());
    case 'ZodLiteral': return { const: definition.value };
    case 'ZodEnum': return { type: 'string', enum: [...definition.values] };
    case 'ZodBoolean': return { type: 'boolean' };
    case 'ZodString': {
      const result = { type: 'string' };
      for (const check of definition.checks) {
        if (check.kind === 'min') result.minLength = check.value;
        if (check.kind === 'max') result.maxLength = check.value;
        if (check.kind === 'regex') result.pattern = check.regex.source;
      }
      return result;
    }
    case 'ZodNumber': {
      const result = { type: 'number' };
      for (const check of definition.checks) {
        if (check.kind === 'int') result.type = 'integer';
        if (check.kind === 'min') result[check.inclusive ? 'minimum' : 'exclusiveMinimum'] = check.value;
        if (check.kind === 'max') result[check.inclusive ? 'maximum' : 'exclusiveMaximum'] = check.value;
      }
      return result;
    }
    case 'ZodArray': return { type: 'array', items: describe(definition.type), ...(definition.minLength ? { minItems: definition.minLength.value } : {}), ...(definition.maxLength ? { maxItems: definition.maxLength.value } : {}) };
    case 'ZodObject': {
      const shape = definition.shape();
      return { type: 'object', properties: Object.fromEntries(Object.entries(shape).map(([key, child]) => [key, describe(child)])), required: Object.entries(shape).filter(([, child]) => !child.isOptional()).map(([key]) => key), additionalProperties: definition.unknownKeys !== 'strict' };
    }
    case 'ZodUnion': case 'ZodDiscriminatedUnion': return { anyOf: [...definition.options].map(describe) };
    default: throw new TypeError(`Native discovery cannot describe ${definition.typeName}.`);
  }
}
