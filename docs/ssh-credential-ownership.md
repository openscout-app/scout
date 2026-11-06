# SSH credential ownership migration

Scout binds new managed SSH records to the complete, socket-authenticated Noise
public key. The short device ID remains display and client compatibility data;
it never selects, migrates or removes a grant. Clients do not supply a new
identity field and do not need to re-pair for the normal migration.

New records use a v1 owner fingerprint. Existing v0 records migrate during
explicit provisioning only when an exact full key or an exact pairing-key
fingerprint establishes ownership. Upgrading alone never rewrites their SSH keys or workspace. Explicit provisioning
replaces only the established owner's grant with the requested key and workspace.
Foreign records are not rewritten. Existing issued SSH access is not
revoked by this migration or by pairing revocation, and active SSH/PTY sessions
are not terminated.

## Ambiguous legacy grants

Earlier production grants commonly contain only a short device ID and
`pairing=unbound`. A matching prefix cannot establish ownership safely. These
records remain byte-for-byte unchanged, and status or re-provisioning refuses
with an ownership-review diagnostic. Existing SSH login continues to work.

The operator must review the affected authorized-key line locally, establish
its owner, and explicitly remove or repair only that grant before provisioning
again from the authenticated device. Re-pairing alone cannot prove historical
ownership and is not a recovery procedure. No automatic bulk deletion, prefix
lookup, trust-list expansion or silent reassignment is performed.

## Admission boundary

The bridge creates an opaque credential capability from a real authenticated
connection and the full key. Credential operations re-read canonical trust;
changed authority, connection closure or replacement permanently invalidates
the old capability, even after regrant. Status re-admits after diagnostic waits,
and provisioning re-admits before committing its credential write. Local host
service identity and plaintext contexts do not receive paired credential rights.

This is a narrow credential-ownership boundary. It does not qualify the general
live-transport registry, all resumed mobile/process effects, credential removal
on pairing revocation, or the later fence-family performance gates.
