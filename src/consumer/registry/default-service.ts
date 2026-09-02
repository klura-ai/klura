import { createPublicKey } from 'node:crypto';
import { readConsumerRuntimeVersion } from '../runtime-version';
import { ConsumerRegistryServiceV1 } from '../registry-service';
import { PackageStoreV1 } from '../store/package-store';
import { RegistryClientV1, type RegistryAuthorityV1 } from './client';

const REGISTRY_INDEX_URL_V1 = 'https://registry.klura.ai/v1/index.signed.json';

const REGISTRY_PUBLIC_KEY_PEM_V1 = `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEAIJpIAWefU6weG10IXG71obd4E28uTKuPbA7e5sewzSE=
-----END PUBLIC KEY-----
`;

const DEFAULT_REGISTRY_AUTHORITY_V1: RegistryAuthorityV1 = {
  index_url: REGISTRY_INDEX_URL_V1,
  public_key: createPublicKey(REGISTRY_PUBLIC_KEY_PEM_V1),
};

/** Creates the sole production registry client for the local consumer surface. */
export function createDefaultConsumerRegistryService(home?: string): ConsumerRegistryServiceV1 {
  const store = new PackageStoreV1(home);
  const registry = new RegistryClientV1(store.paths.home, DEFAULT_REGISTRY_AUTHORITY_V1);
  return new ConsumerRegistryServiceV1(registry, store, readConsumerRuntimeVersion());
}
