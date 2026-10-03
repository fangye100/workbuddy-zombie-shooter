"""Resolve-only regression; stdlib mocks prevent real plugin/model requests."""
import importlib.util
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

SOURCE = Path(__file__).resolve().parents[2] / 'assets/characters/_tools/gen3d_from_image.py'

class BuddyResolution(unittest.TestCase):
    def resolve(self, cache_name=None, fixed_name=None, override=False):
        with tempfile.TemporaryDirectory(prefix='buddy-resolution-') as temporary:
            chosen = Path(temporary)/('override.py' if override else cache_name or fixed_name)
            chosen.write_text('# fixture only',encoding='utf-8')
            def glob_paths(pattern):
                return [str(chosen)] if cache_name and pattern.endswith('\\'+cache_name) else []
            def exists(p):
                return p == str(chosen) or bool(fixed_name and p.endswith('\\'+fixed_name))
            with patch.dict(os.environ, {'BUDDY_CLOUD_PY': str(chosen) if override else ''}), patch('glob.glob',side_effect=glob_paths), patch('os.path.isfile',side_effect=exists):
                spec=importlib.util.spec_from_file_location('buddy_resolution_fixture',SOURCE); module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
                result=module.resolve_buddy()
                self.assertTrue(exists(result));return result
    def test_new_name_in_versioned_cache_only(self):
        self.assertTrue(self.resolve(cache_name='buddy-multimodal-generation.py').endswith('buddy-multimodal-generation.py'))
    def test_legacy_name_in_versioned_cache_only(self):
        self.assertTrue(self.resolve(cache_name='buddy-cloud.py').endswith('buddy-cloud.py'))
    def test_fixed_new_and_legacy_names(self):
        for name in ('buddy-multimodal-generation.py','buddy-cloud.py'):
            with self.subTest(name=name): self.assertTrue(self.resolve(fixed_name=name).endswith(name))
    def test_environment_override_has_priority(self):
        self.assertTrue(self.resolve(cache_name='buddy-cloud.py',override=True).endswith('override.py'))

if __name__ == '__main__': unittest.main(verbosity=2)
