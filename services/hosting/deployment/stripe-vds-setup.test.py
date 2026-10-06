import importlib.util
import pathlib
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('setup_under_test', pathlib.Path(__file__).with_name('stripe-vds-setup.py'))
setup = importlib.util.module_from_spec(spec)
spec.loader.exec_module(setup)

class RecoveryTests(unittest.TestCase):
    def state(self):
        return {'activationStarted': True, 'phase': 'staged', 'backup': '/private/mock-backup',
                'originalSha256': setup.digest(b'old\n'), 'candidateSha256': setup.digest(b'old\nnew\n')}

    def test_failure_restores_bytes_after_guarded_database_rollback(self):
        state = self.state()
        events = []
        files = {setup.ENV_PATH: b'old\nnew\n', pathlib.Path(state['backup']): b'old\n'}
        def atomic(path, data):
            events.append(('restore', path))
            files[path] = data
        with patch.object(setup, 'step', side_effect=lambda *a: events.append(('db', a[0]))), \
             patch.object(setup, 'private_file', side_effect=lambda p: files[p]), \
             patch.object(setup, 'atomic', side_effect=atomic), \
             patch.object(setup, 'recreate', side_effect=lambda: events.append(('recreate',))), \
             patch.object(setup, 'health'), patch.object(setup, 'save'):
            result = setup.rollback(state)
        self.assertEqual(files[setup.ENV_PATH], b'old\n')
        self.assertEqual([e[0] for e in events], ['db', 'restore', 'recreate'])
        self.assertTrue(result['endpointAndCredentialsRetained'])

    def test_interrupted_rollback_reloads_backend_even_when_file_is_already_old(self):
        state = self.state()
        with patch.object(setup, 'step'), patch.object(setup, 'private_file', return_value=b'old\n'), \
             patch.object(setup, 'backend_has_new_keys', return_value=True), patch.object(setup, 'recreate') as recreate, \
             patch.object(setup, 'health'), patch.object(setup, 'save'):
            setup.rollback(state)
        recreate.assert_called_once_with()

    def test_concurrent_environment_edit_is_not_overwritten(self):
        state = self.state()
        with patch.object(setup, 'step'), patch.object(setup, 'private_file', return_value=b'other-new-field\n'), \
             patch.object(setup, 'atomic') as atomic, patch.object(setup, 'recreate') as recreate:
            with self.assertRaisesRegex(setup.Stop, 'concurrent_env_change_preserved'):
                setup.rollback(state)
        atomic.assert_not_called()
        recreate.assert_not_called()

    def test_payments_guard_failure_preserves_credentials_and_running_backend(self):
        state = self.state()
        with patch.object(setup, 'step', side_effect=setup.Stop('rollback_blocked_payments_exist')), \
             patch.object(setup, 'atomic') as atomic, patch.object(setup, 'recreate') as recreate:
            with self.assertRaisesRegex(setup.Stop, 'rollback_blocked_payments_exist'):
                setup.rollback(state)
        atomic.assert_not_called()
        recreate.assert_not_called()

if __name__ == '__main__':
    unittest.main()
