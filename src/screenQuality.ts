/** Preserve the negotiated encoding IDs; changing their count breaks setParameters. */
export function screenQualityParameters(
  parameters: RTCRtpSendParameters,
  fullscreen: boolean,
): RTCRtpSendParameters | null {
  if (!parameters.encodings.length) return null; // Retry after SDP is stable.
  return {
    ...parameters,
    degradationPreference: fullscreen ? "maintain-resolution" : "balanced",
    encodings: parameters.encodings.map((encoding) => {
      const next = { ...encoding, maxFramerate: 30, scaleResolutionDownBy: 1 };
      // The source is not upscaled: fullscreen asks for native captured pixels.
      if (fullscreen) next.maxBitrate = 8_000_000;
      else delete next.maxBitrate;
      return next;
    }),
  };
}
