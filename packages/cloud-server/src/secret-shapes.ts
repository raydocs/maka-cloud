// The scrubber lives in the orchestrator package so the runners and the gateway can use the same
// module instance (and so the same list of known secrets) as the server.
export {
  containsSecret,
  linkedSecretKeys,
  linkedSecretPair,
  scrubSecretFields,
  scrubSecretShapes,
  scrubReading,
  scrubSecretText,
  setKnownSecrets,
  withoutHidden,
  withoutInvisible,
} from '@maka-cloud/orchestrator';
