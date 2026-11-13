import type { JsonRpcProvider } from 'near-api-js';

/** What an access key may do: anything (full access), only some contract calls, or it isn't there. */
export type KeyPermission = 'full' | 'function_call' | null;

/**
 * Looks up one public key on an account (RPC `view_access_key`, final block). A missing account or
 * key is null; any other failure (the RPC down, rate limited) throws, so a sign-in fails closed.
 */
export async function accessKeyPermission(
  provider: JsonRpcProvider,
  accountId: string,
  publicKey: string,
): Promise<KeyPermission> {
  try {
    const key = await provider.viewAccessKey({ accountId, publicKey });
    return key.permission === 'FullAccess' ? 'full' : 'function_call';
  } catch (err) {
    if (
      /does not exist|doesn't exist|UNKNOWN_ACCOUNT|UNKNOWN_ACCESS_KEY|AccessKeyDoesNotExist|AccountDoesNotExist/i.test(
        String(err),
      )
    )
      return null;
    throw err;
  }
}
