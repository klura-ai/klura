import { verify, type KeyObject } from 'node:crypto';
import { canonicalJson, type JsonValueV1 } from '../../public/contracts/json';
import {
  parseSignedRegistryIndex,
  type SignedRegistryIndexV1,
} from '../../public/contracts/registry-index';
import { PublicContractError } from '../../public/contracts/common';

export function verifySignedRegistryIndex(
  candidate: unknown,
  publicKey: string | Uint8Array | KeyObject,
): SignedRegistryIndexV1 {
  const index = parseSignedRegistryIndex(candidate);
  const signature = Buffer.from(index.signature.value, 'base64url');
  if (signature.length !== 64) {
    throw new PublicContractError(
      'signed_index.signature.value',
      'must decode to a 64-byte Ed25519 signature',
    );
  }
  const payload = Buffer.from(canonicalJson(index.payload as unknown as JsonValueV1), 'utf8');
  const verificationKey =
    publicKey instanceof Uint8Array && !Buffer.isBuffer(publicKey)
      ? Buffer.from(publicKey)
      : publicKey;
  if (!verify(null, payload, verificationKey, signature)) {
    throw new PublicContractError(
      'signed_index.signature',
      'does not verify against the registry public key',
    );
  }
  return index;
}
