"""Upload this repository to its Hugging Face Space.

The script uses the Hub upload API, so it never force pushes and it works with
the starter commit that Hugging Face creates for a new Space. Only the files the
Docker build needs go up. The token comes from the HF_TOKEN environment variable
and the script never prints it.

Environment:
  HF_TOKEN       write token for the Space (a GitHub Actions secret)
  HF_SPACE_ID    owner/name of the Space, for example Cozmik7/titan-gev
  GITHUB_SHA     optional, used in the commit message
"""

import os
import sys

from huggingface_hub import HfApi

ALLOW = [
    "Dockerfile",
    ".dockerignore",
    "README.md",
    "LICENSE",
    "NOTICE.md",
    "UPSTREAM_COMMIT",
    "package.json",
    "server/**",
    "scripts/fetch-upstream.sh",
]
# Remove stale copies of files that moved or vanished from these folders.
DELETE = ["server/**", "scripts/**"]


def main() -> int:
    token = os.environ.get("HF_TOKEN", "").strip()
    space_id = os.environ.get("HF_SPACE_ID", "").strip()
    if not token:
        print("HF_TOKEN is not set. Skipping the Space sync.")
        return 0
    if "/" not in space_id:
        print("HF_SPACE_ID must look like owner/name.", file=sys.stderr)
        return 1

    sha = os.environ.get("GITHUB_SHA", "")[:7] or "manual"
    api = HfApi(token=token)
    try:
        info = api.upload_folder(
            repo_id=space_id,
            repo_type="space",
            folder_path=".",
            allow_patterns=ALLOW,
            delete_patterns=DELETE,
            commit_message=f"Sync from GitHub {sha}",
        )
    except Exception as error:  # noqa: BLE001 - report the failure without leaking the token
        message = str(error).replace(token, "[redacted]")
        print(f"Space sync failed: {type(error).__name__}: {message}", file=sys.stderr)
        return 1
    print(f"Synced {space_id} at {info.oid[:7] if getattr(info, 'oid', None) else 'new commit'}.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
