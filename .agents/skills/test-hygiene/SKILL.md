---
name: test-hygiene
description: Keep Scout's test suite focused when adding or changing tests, or removing a feature, file, flag or command. Use the change as a chance to tidy related coverage through judgment, not a test budget or another gate.
---

# Test hygiene

Leave the suite with the smallest useful set of tests that protects the
behavior. A test change or removal is a good moment to tidy nearby coverage,
not a reason to audit the whole repository.

Before adding a test, look for an existing test of the same behavior. If it
already covers the case, merge the two or drop the redundant test. Prefer one
test per behavior through the public path over several tests that mirror
implementation details. Similar names alone do not make tests redundant;
consider the failures each one can catch.

When removing a feature, file, flag or command, follow its test support too.
Delete the tests, fixtures, scripts and package.json entries that belonged only
to the removed behavior. Check for remaining callers before removing shared
support.

Keep tests that reproduced a real bug, and failure-case tests for durable
writes, concurrency and destructive operations. A smaller test count is not a
reason to lose those protections.

In the PR, briefly say what was removed or why the suite grew. Use judgment
about the coverage the change needs; there is no test budget or extra check.
