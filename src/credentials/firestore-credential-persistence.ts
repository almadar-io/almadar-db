/**
 * Firestore persistence for the tenant credential store (W4).
 *
 * Rows are AES-256-GCM ciphertext documents written by integrations'
 * `CredentialStore`; this class only moves them. It is the shared Firestore row store with the top-level
 * layout (collection name = the store's `CREDENTIAL_ENTITY_TYPE`); pass a
 * `root` (`hosted/<appId>`) to keep one app's credentials apart from another's.
 */
import { FirestorePersistence } from '../firestore/persistence.js';

export class FirestoreCredentialPersistence extends FirestorePersistence {
  constructor(root = '') {
    super({ root });
  }
}
