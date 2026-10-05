"""Budget-search regressions; stub decimation, never modify real assets."""
import contextlib
import io
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
import tune_env_budget as tune


class BudgetSearchTests(unittest.TestCase):
    def run_probe(self, results, factor=12):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            props = root / 'props.json'
            props.write_text(json.dumps({'entries': [{'id': key, 'tris': 100} for key in results]}))
            models = root / 'models'
            for key in results:
                (models / key).mkdir(parents=True)
                (models / key / (key + '.glb')).write_bytes(b'fixture')
            reports = root / '.workbuddy/tmp/lodtest'
            reports.mkdir(parents=True)
            targets = []
            def probe(raw, target, _tempdir):
                key = Path(raw).stem
                targets.append((key, target))
                return (target, 1, 100) if results[key] else None
            with patch.object(tune, 'PROPS', str(props)), patch.object(tune, 'MODELS', str(models)), \
                 patch.object(tune, 'ASSETS', str(root / 'assets')), \
                 patch.object(tune, 'try_target', side_effect=probe), \
                 patch.object(tune.sys, 'argv', ['tune', '--max-factor', str(factor)]), \
                 contextlib.redirect_stdout(io.StringIO()):
                self.assertEqual(tune.main(), 0)
            report = reports / 'budget_suggest.json'
            return targets, json.loads(report.read_text(encoding='utf-8')) if report.exists() else None

    def test_failure_after_success_does_not_reuse_previous_asset_candidate(self):
        _, report = self.run_probe({'A': True, 'B': False})
        self.assertTrue(report['A']['ok'])
        self.assertFalse(report['B']['ok'])
        self.assertNotIn('suggest_faces', report['B'])

    def test_first_asset_failure_does_not_read_an_unbound_candidate(self):
        targets, report = self.run_probe({'A': False})
        self.assertTrue(targets)
        self.assertIsNone(report)

    def test_requested_ceiling_limits_search_and_includes_nonstandard_endpoint(self):
        for factor in (4, 2.5, 16):
            with self.subTest(factor=factor):
                targets, _ = self.run_probe({'A': False}, factor)
                self.assertEqual(targets[-1][1], int(100 * factor))
                self.assertTrue(all(value <= 100 * factor for _, value in targets))
                self.assertEqual(len(targets), len(set(targets)))

    def test_nonfinite_or_nonpositive_factor_is_rejected(self):
        for factor in ('nan', 'inf', '0', '-1'):
            with self.subTest(factor=factor), patch.object(tune.sys, 'argv', ['tune', '--max-factor', factor]), \
                 contextlib.redirect_stderr(io.StringIO()), self.assertRaises(SystemExit) as error:
                tune.main()
            self.assertEqual(error.exception.code, 2)


if __name__ == '__main__':
    unittest.main()
