import importlib.util
import json
import pathlib
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('crypto_proof', pathlib.Path(__file__).with_name('unpaid-crypto-proof.py'))
proof = importlib.util.module_from_spec(spec)
spec.loader.exec_module(proof)

class ProofTests(unittest.TestCase):
    def fixture(self):
        state = {'paymentId': 'own-payment', 'orderId': 'own-order', 'userId': 'own-user', 'externalId': 'own-external'}
        upstream = {'clientEvents': [{'id': 'own-event', 'type': 'payment.canceled', 'deliveredToOwnApp': True}],
            'cryptomus': {'expectedEvent': 'payment.canceled', 'status': 'cancel', 'receivedZeroVerified': True,
                'final': True, 'naturalExpiryReached': True, 'expiresAt': '2026-10-05T12:15:00Z'},
            'waiPay': {'status': 'CANCELLED', 'paidAmountMinor': 0}, 'verifiedCryptomusTerminalEvents': [{'logId': 'real-event'}]}
        local = {'receipts': [{'id': 'wai:own-event', 'type': 'payment.canceled'}], 'paidAmountMinor': 0,
            'paidAtPresent': False, 'serverIdPresent': False, 'serverCount': 0, 'attemptState': 'canceled', 'capacityState': 'released'}
        return state, upstream, local

    def verify(self, state, upstream, local):
        with patch.object(proof, 'backend', return_value=upstream), patch.object(proof, 'local_evidence', return_value=local), patch.object(proof, 'write_private') as write:
            result = proof.verify(state)
            write.assert_called_once()
            return result

    def test_real_unpaid_expiry_receipt_releases_capacity(self):
        self.assertTrue(self.verify(*self.fixture())['passed'])

    def test_cancel_with_nullable_uninitialized_amount_passes_without_explicit_zero(self):
        state, upstream, local = self.fixture()
        upstream['cryptomus'].update(receivedZeroVerified=False, receivedAmountNull=True, uninitializedInvoice=True, cancellationUnpaidVerified=True)
        result = self.verify(state, upstream, local)
        self.assertTrue(result['passed'])
        self.assertFalse(result['upstream']['cryptomus']['receivedZeroVerified'])

    def test_null_cancellation_requires_every_guard_and_real_callback(self):
        for update in ({'receivedAmountNull': False}, {'uninitializedInvoice': False}, {'cancellationUnpaidVerified': False}, {'status': 'expired'}, {'final': False}):
            state, upstream, local = self.fixture()
            upstream['cryptomus'].update(receivedZeroVerified=False, receivedAmountNull=True, uninitializedInvoice=True, cancellationUnpaidVerified=True)
            upstream['cryptomus'].update(update)
            self.assertFalse(self.verify(state, upstream, local)['passed'])
        state, upstream, local = self.fixture()
        upstream['cryptomus'].update(receivedZeroVerified=False, receivedAmountNull=True, uninitializedInvoice=True, cancellationUnpaidVerified=True)
        upstream['verifiedCryptomusTerminalEvents'] = []
        self.assertFalse(self.verify(state, upstream, local)['passed'])

    def test_missing_wrong_receipt_or_capacity_cannot_pass(self):
        for update in ({'receipts': []}, {'receipts': [{'id': 'wai:foreign', 'type': 'payment.canceled'}]},
            {'capacityState': 'reserved'}, {'serverCount': 1}, {'paidAmountMinor': 1}, {'attemptState': 'pending'}):
            state, upstream, local = self.fixture()
            local.update(update)
            self.assertFalse(self.verify(state, upstream, local)['passed'])

    def test_pending_expiry_is_an_explicit_nonblocking_phase_result(self):
        state, upstream, local = self.fixture()
        upstream['cryptomus'].update(status='check', final=False, naturalExpiryReached=False, expectedEvent=None)
        upstream['waiPay']['status'] = 'PROCESSING'
        result = self.verify(state, upstream, local)
        self.assertFalse(result['passed'])
        self.assertTrue(result['pendingNaturalExpiry'])
        self.assertEqual(result['verifyAfter'], '2026-10-05T12:15:00Z')

    def test_saved_payment_cannot_be_rebound_to_another_id(self):
        state = {'externalId': 'own-external', 'orderId': 'own-order', 'userId': 'own-user', 'paymentId': 'own-payment'}
        payment = {'externalPaymentId': state['externalId'], 'providerAccountId': 'cryptomus-main', 'provider': 'cryptomus',
            'mode': 'live', 'requestedAmountMinor': 1200, 'currency': 'USDT', 'paidAmountMinor': 0, 'refundedAmountMinor': 0,
            'metadata': {'wai_order_id': state['orderId'], 'wai_user_id': state['userId']}, 'id': 'different-payment'}
        with patch.object(proof, 'write_private') as write:
            with self.assertRaisesRegex(proof.Stop, 'persisted_payment_changed'): proof.bind_payment(state, {'payment': payment})
            write.assert_not_called()

    def test_reused_qa_account_requires_previous_capacity_release(self):
        old = {'email': 'wai-vds-unpaid-a7f963e1-e0ff-4950-b8fe-16e7c7647489@example.invalid', 'password': 'mock-only-'*8,
            'userId': 'old-user', 'paymentId': 'old-payment'}
        _, _, local = self.fixture()
        with tempfile.TemporaryDirectory() as directory:
            path = pathlib.Path(directory)/'state.json'; path.write_text('{}')
            with patch.object(proof, 'STRIPE_STATE', path), patch.object(proof, 'private_bytes', return_value=json.dumps(old).encode()), patch.object(proof, 'local_evidence', return_value=local):
                first = proof.initial_state()
                self.assertEqual(first['email'], old['email'])
                self.assertEqual(first['purpose'], 'site')
                self.assertTrue(first['orderKey'].startswith('crypto-unpaid-proof-'))
                local['capacityState'] = 'reserved'
                with self.assertRaisesRegex(proof.Stop, 'previous_qa_capacity_not_released'): proof.initial_state()

if __name__ == '__main__': unittest.main()
