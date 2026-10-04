"""Compatibility entry point for the environment LOD1/LOD2 pipeline.

Stage: python regen_env_lods.py --only P-01 --jobs 1
Publish: python regen_env_lods.py --only P-01 --publish
Targets and source orientation live in each LOD1 sidecar's userData.lodBuild.
The former single-level algorithm is retired; no chart-count-derived budgets.
"""
from build_environment_lods import main

if __name__ == '__main__':
    raise SystemExit(main())
