// Interaction specification, not an API client. All orders in this preview are simulated.
export const phases = ['offer', 'checkout', 'verifying', 'paymentFailed', 'creating', 'installing', 'checking',
  'setupDelayed', 'uncertain', 'openai', 'authorizing', 'ready', 'offline', 'authExpired', 'cancelled', 'expired', 'unavailable',
  'openaiOutage', 'ownerRequired', 'pairingRevoked', 'codeExpired'];

export function initialState() {
  return { version: 1, phase: 'offer', role: 'owner', orderId: null, paid: false, hostReady: false, accountConnected: false, autoRenew: false };
}

export function transition(previous, event) {
  const state = { ...previous };
  switch (event.type) {
    case 'CHECKOUT':
      if (['offer', 'paymentFailed'].includes(state.phase) && !state.paid) state.phase = 'checkout';
      break;
    case 'PAYMENT_RETURN':
      if (state.phase === 'checkout') state.phase = 'verifying';
      break;
    case 'PAYMENT_CONFIRMED':
      if (['checkout', 'verifying'].includes(state.phase) && !state.orderId) {
        state.orderId = 'demo-order-1'; state.paid = true; state.phase = 'creating';
      }
      break;
    case 'PAYMENT_FAILED':
      if (!state.paid && ['checkout', 'verifying'].includes(state.phase)) state.phase = 'paymentFailed';
      break;
    case 'CREATED': if (state.phase === 'creating' && state.paid) state.phase = 'installing'; break;
    case 'INSTALLED': if (state.phase === 'installing') state.phase = 'checking'; break;
    case 'HEALTHY':
      if (['checking', 'setupDelayed', 'uncertain', 'offline'].includes(state.phase) && state.paid) {
        state.hostReady = true; state.phase = state.accountConnected ? 'ready' : 'openai';
      }
      break;
    case 'OPENAI_LOGIN':
      if (state.role === 'owner' && ['openai', 'authExpired', 'codeExpired'].includes(state.phase) && state.hostReady) state.phase = 'authorizing';
      break;
    case 'AUTH_GRANTED':
      if (state.role === 'owner' && state.phase === 'authorizing' && state.hostReady) { state.accountConnected = true; state.phase = 'ready'; }
      break;
    case 'AUTH_CANCELLED': if (state.phase === 'authorizing') state.phase = 'openai'; break;
    case 'AUTH_TIMED_OUT': if (state.phase === 'authorizing') state.phase = 'codeExpired'; break;
    case 'AUTH_EXPIRED':
      if (['ready', 'cancelled'].includes(state.phase)) { state.accountConnected = false; state.phase = state.role === 'owner' ? 'authExpired' : 'ownerRequired'; }
      break;
    case 'OPENAI_UNAVAILABLE': if (state.phase === 'ready') state.phase = 'openaiOutage'; break;
    case 'OPENAI_AVAILABLE': if (state.phase === 'openaiOutage') state.phase = 'ready'; break;
    case 'OWNER_RECONNECTED':
      if (state.phase === 'ownerRequired') { state.accountConnected = true; state.phase = 'ready'; }
      break;
    case 'PAIRING_REVOKED': if (['ready', 'offline'].includes(state.phase)) { state.phase = 'pairingRevoked'; state.hostReady = false; } break;
    case 'DISCONNECTED': if (['ready', 'cancelled'].includes(state.phase)) state.phase = 'offline'; break;
    case 'CREATE_UNKNOWN': if (state.phase === 'creating') state.phase = 'uncertain'; break;
    case 'SETUP_DELAYED': if (['creating', 'installing', 'checking'].includes(state.phase)) state.phase = 'setupDelayed'; break;
    case 'CANCEL_RENEWAL':
      if (state.role === 'owner' && ['ready', 'cancelled'].includes(state.phase)) { state.autoRenew = false; state.phase = 'cancelled'; }
      break;
    case 'SET_AUTORENEW': if (state.role === 'owner' && ['offer', 'checkout'].includes(state.phase)) state.autoRenew = event.enabled === true; break;
    case 'RETRY_STATUS':
      // In production this means GET existing order, not another payment or create request.
      break;
    case 'BACK': if (['checkout', 'paymentFailed', 'unavailable'].includes(state.phase) && !state.paid) state.phase = 'offer'; break;
  }
  return state;
}

export function scenario(phase) {
  if (!phases.includes(phase)) return initialState();
  const state = initialState();
  state.phase = phase;
  if (['creating', 'installing', 'checking', 'setupDelayed', 'uncertain', 'openai', 'authorizing', 'ready', 'offline', 'authExpired', 'cancelled', 'expired', 'openaiOutage', 'ownerRequired', 'pairingRevoked', 'codeExpired'].includes(phase)) {
    state.paid = true; state.orderId = 'demo-order-1';
  }
  state.hostReady = ['openai', 'authorizing', 'ready', 'offline', 'authExpired', 'cancelled', 'expired', 'openaiOutage', 'ownerRequired', 'codeExpired'].includes(phase);
  state.accountConnected = ['ready', 'offline', 'cancelled', 'expired', 'openaiOutage', 'pairingRevoked'].includes(phase);
  if (phase === 'ownerRequired') state.role = 'member';
  return state;
}

export function restore(serialized) {
  try {
    const state = JSON.parse(serialized);
    if (state?.version !== 1 || !phases.includes(state.phase)) return initialState();
    const expected = scenario(state.phase);
    if (state.paid !== expected.paid || state.orderId !== expected.orderId
      || typeof state.hostReady !== 'boolean' || typeof state.accountConnected !== 'boolean'
      || typeof state.autoRenew !== 'boolean' || !['owner', 'member'].includes(state.role)) return initialState();
    if (['ready', 'cancelled'].includes(state.phase) && (!state.hostReady || !state.accountConnected)) return initialState();
    if (!state.paid && (state.hostReady || state.accountConnected)) return initialState();
    // Copy only the known fields; never restore credentials or arbitrary stored data.
    return Object.fromEntries(Object.keys(initialState()).map(key => [key, state[key]]));
  } catch { return initialState(); }
}

export function canCreateNewOrder(state) { return state.role === 'owner' && !state.paid && state.orderId === null && ['offer', 'checkout', 'paymentFailed'].includes(state.phase); }
