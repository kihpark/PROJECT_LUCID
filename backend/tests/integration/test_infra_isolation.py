"""Infrastructure isolation - documents the post-feat/infra-agent-isolation
invariant that backend container code is the image, not the host tree.

These tests are documentation more than enforcement. They only run when
LUCID_INFRA_ISOLATION_VERIFY=1 is set and a `lucid-backend-1` container
is reachable from the test runner. The real verification is the manual
smoke in INFRA_ISOLATION_MANUAL_SMOKE.md (host-write-marker-not-visible
inside container).

Run from the host (NOT inside the backend container — these tests
compare host file content to container file content):

    LUCID_INFRA_ISOLATION_VERIFY=1 \\
        pytest backend/tests/integration/test_infra_isolation.py -v
"""

from __future__ import annotations

import hashlib
import os
import shutil
import subprocess
from pathlib import Path

import pytest

VERIFY = os.getenv("LUCID_INFRA_ISOLATION_VERIFY") == "1"
pytestmark = pytest.mark.skipif(
    not VERIFY,
    reason="set LUCID_INFRA_ISOLATION_VERIFY=1 (run from host with docker available)",
)


def _docker_available() -> bool:
    return shutil.which("docker") is not None


def _container_file_md5(rel_path: str) -> str | None:
    """Return md5 of `rel_path` inside the `lucid-backend-1` container, or None."""
    if not _docker_available():
        return None
    try:
        out = subprocess.run(
            [
                "docker",
                "compose",
                "exec",
                "-T",
                "backend",
                "python",
                "-c",
                f"import hashlib; print(hashlib.md5(open('/app/{rel_path}', 'rb').read()).hexdigest())",
            ],
            capture_output=True,
            text=True,
            timeout=20,
            check=True,
        )
        return out.stdout.strip()
    except (
        subprocess.CalledProcessError,
        subprocess.TimeoutExpired,
        FileNotFoundError,
    ):
        return None


def _host_file_md5(rel_path: str) -> str | None:
    """Return md5 of the host's `backend/<rel_path>`."""
    # The test file lives at backend/tests/integration/test_infra_isolation.py
    # backend/ is two parents up.
    backend_root = Path(__file__).resolve().parents[2]
    path = backend_root / rel_path
    if not path.exists():
        return None
    return hashlib.md5(path.read_bytes()).hexdigest()


def test_backend_container_has_main() -> None:
    """The backend container's image carries /app/api/main.py."""
    if not _docker_available():
        pytest.skip("docker CLI not on PATH from this runner")
    container_md5 = _container_file_md5("api/main.py")
    assert container_md5 is not None, (
        "could not read /app/api/main.py from container — "
        "is `lucid-backend-1` up? `docker compose up -d backend`"
    )
    assert len(container_md5) == 32  # md5 hex


def test_host_edit_does_not_appear_in_container() -> None:
    """A host write to `backend/api/main.py` MUST NOT appear in the container.

    Strategy: append a uniquely-tagged comment to the host file, then read
    the container's view of the same path. The tag must be absent.

    Cleanup: the host change is reverted at the end (try/finally).
    """
    if not _docker_available():
        pytest.skip("docker CLI not on PATH from this runner")

    backend_root = Path(__file__).resolve().parents[2]
    host_main = backend_root / "api" / "main.py"
    if not host_main.exists():
        pytest.skip(f"host main.py missing at {host_main}")

    original = host_main.read_bytes()
    marker = "# infra-isolation-test-marker-7f3a2b91"
    try:
        host_main.write_bytes(original + f"\n{marker}\n".encode())

        # Read the container's view (its image-baked copy, no bind mount).
        proc = subprocess.run(
            [
                "docker",
                "compose",
                "exec",
                "-T",
                "backend",
                "grep",
                "-c",
                marker,
                "/app/api/main.py",
            ],
            capture_output=True,
            text=True,
            timeout=20,
            check=False,
        )
        # grep exit 1 = no match (the expected outcome).
        # grep exit 0 = match found (= bind mount still active, FAIL).
        assert proc.returncode == 1, (
            "host write reached the running container — bind-mount is still "
            f"active. grep stdout={proc.stdout!r} stderr={proc.stderr!r}"
        )
    finally:
        host_main.write_bytes(original)


def test_backend_container_md5_differs_from_host_after_marker_append() -> None:
    """Sanity: after a host-only marker append, host md5 != container md5."""
    if not _docker_available():
        pytest.skip("docker CLI not on PATH from this runner")

    backend_root = Path(__file__).resolve().parents[2]
    host_main = backend_root / "api" / "main.py"
    if not host_main.exists():
        pytest.skip(f"host main.py missing at {host_main}")

    original = host_main.read_bytes()
    try:
        host_main.write_bytes(original + b"\n# md5-divergence-marker\n")
        host_md5 = _host_file_md5("api/main.py")
        container_md5 = _container_file_md5("api/main.py")
        assert host_md5 is not None
        assert container_md5 is not None
        assert host_md5 != container_md5, (
            "host and container md5 match even after host-only edit — "
            "bind mount appears still active"
        )
    finally:
        host_main.write_bytes(original)
