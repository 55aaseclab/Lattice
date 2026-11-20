const error = (status, code) => Object.assign(new Error(code), { status, code });
export function createBusinessHooks({ slidesRequiredActions, slidesErrorDetails }) {
  return {
    collectActions: true, ownerOnlyActions: ['manage_lock'],
    assertionFields: ['authorizationExpiresAt', 'firstPartyNative'],
    assertionRules: { authorizationExpiresAt: { kind: 'authorization-expiry' }, firstPartyNative: { kind: 'native-session' } },
    requiredActions: request => slidesRequiredActions(request.operation, request.input),
    prepareInvocation: (request, ctx) => ({ assertion: { authorizationExpiresAt: ctx.authorizationExpiresAt, firstPartyNative: ctx.firstPartyNative } }),
    responseLimit: request => request.operation === 'get_artifact' ? 8 * 1024 * 1024 : 4 * 1024 * 1024,
    errorDetails: slidesErrorDetails,
    formatMcpResult(request, args, result) {
      if (request.operation !== 'get_artifact' || args.mode !== 'inline' || !/^image\/(png|jpeg|webp)$/.test(result.artifact?.mimeType || '')) return null;
      const { base64, ...artifact } = result.artifact;
      if (typeof base64 !== 'string' || !/^[A-Za-z0-9+/]+={0,2}$/.test(base64) || base64.length > 6 * 1024 * 1024) throw error(502, 'INVALID_APP_RESPONSE');
      const metadata = { ...result, artifact };
      return { content: [{ type: 'text', text: JSON.stringify(metadata) }, { type: 'image', data: base64, mimeType: artifact.mimeType }], structuredContent: metadata };
    },
  };
}
