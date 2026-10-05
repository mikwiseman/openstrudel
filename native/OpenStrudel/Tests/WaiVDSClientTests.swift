import Foundation
import CryptoKit
import Testing

private final class WaiVDSFixtureBundle: NSObject {}

@Suite(.serialized)
struct WaiVDSClientTests {
    private let date = Date(timeIntervalSince1970: 1_791_215_363.310)
    private let hex = String(repeating: "a", count: 64)

    private func fixture(_ name: String, change: ([String: Any]) -> [String: Any] = { $0 }) throws -> Data {
        let url = try #require(Bundle(for: WaiVDSFixtureBundle.self).url(forResource: "wai-vds-v2", withExtension: "json"))
        let all = try #require(JSONSerialization.jsonObject(with: Data(contentsOf: url)) as? [String: Any])
        return try JSONSerialization.data(withJSONObject: change(try #require(all[name] as? [String: Any])))
    }
    private func object(_ data: Data) throws -> [String: Any] { try #require(JSONSerialization.jsonObject(with: data) as? [String: Any]) }
    private func order(_ name: String) throws -> WaiVDSOrder { try WaiVDSContract.decode(WaiVDSOrder.self, from: fixture(name)) }
    private func quote() throws -> WaiVDSQuote { try WaiVDSContract.decode(WaiVDSQuote.self, from: fixture("quote")) }
    @MainActor private func loggedIn() -> WaiVDSSavedState {
        var state = WaiVDSSavedState()
        state.tokens = .init(access: "os_access_" + hex, refresh: "os_refresh_" + hex,
            expiresAt: date.addingTimeInterval(900), refreshExpiresAt: date.addingTimeInterval(86_400), signedInAt: date, sessionId: "test-owner-session")
        return state
    }
    @MainActor private func prepared() throws -> WaiVDSSavedState {
        var state = loggedIn()
        state.offer = .init(quote: try quote(), sessionId: state.tokens!.sessionId)
        return state
    }
    @MainActor private func savedIntent(name: String = "order") throws -> WaiVDSSavedState {
        var state = loggedIn(); let quote = try quote(); let order = try order(name)
        state.intent = .init(quote: quote, installationId: order.installationId, returnState: "test-payment-state-123456",
                            payload: Data("saved-exact-request".utf8), sessionId: state.tokens!.sessionId, attempted: true, order: order)
        state.installations[order.installationId] = .init(id: order.installationId, privateKeyPEM: P256.Signing.PrivateKey().pemRepresentation,
                                                       ownerToken: hex, releaseHash: quote.profile.releaseSha256)
        return state
    }

    @Test func publishedCatalogIsSuitableButHasNoHomePriceOrPurchase() throws {
        let catalog = try WaiVDSContract.decode(WaiVDSCatalog.self, from: fixture("catalog"))
        try catalog.validate()
        #expect(catalog.profile.ramMb == 4096 && catalog.profile.diskGb == 30 && catalog.profile.publicIpv4 == 1)
        #expect(!catalog.purchaseEnabled && catalog.paymentMethods.allSatisfy { $0.amountMinor == nil })
        #expect(!catalog.platforms.ios.purchaseEnabled && !WaiVDSContract.availableInApp)
    }
    @Test func inadequateProfileOrChangedBootstrapCannotBeAccepted() throws {
        for (key, value) in [("ram_mb", 2048 as Any), ("disk_gb", 20 as Any), ("public_ipv4", 0 as Any),
                             ("release_sha256", hex as Any), ("recipe_sha256", hex as Any), ("release_url", "https://other.example/home" as Any)] {
            let data = try fixture("quote") { original in
                var v = original; var profile = v["profile"] as! [String: Any]; profile[key] = value; v["profile"] = profile; return v
            }
            #expect(throws: WaiVDSFailure.self) { try WaiVDSContract.decode(WaiVDSQuote.self, from: data).validate(at: date) }
        }
    }
    @Test func quoteRequiresCurrentFinalPriceAndKeepsUSDTDistinct() throws {
        let original = try quote(); try original.validate(at: date)
        #expect(original.priceText.contains("USD") && !original.priceText.contains("USDT"))
        #expect(throws: WaiVDSFailure.quoteExpired) { try original.validate(at: date.addingTimeInterval(900)) }
        let crypto = try fixture("quote") { var v = $0; v["payment_method"] = "crypto"; v["currency"] = "USDT"; return v }
        let cryptoQuote = try WaiVDSContract.decode(WaiVDSQuote.self, from: crypto); try cryptoQuote.validate(at: date)
        #expect(cryptoQuote.priceText.contains("USDT"))
        for (key, value) in [("currency_exponent", 6 as Any), ("currency", "USDT" as Any), ("total_is_final", false as Any),
                             ("amount_minor", 0 as Any), ("automatic_renewal", true as Any), ("platform", "ios" as Any)] {
            let data = try fixture("quote") { var v = $0; v[key] = value; return v }
            #expect(throws: WaiVDSFailure.self) { try WaiVDSContract.decode(WaiVDSQuote.self, from: data).validate(at: date) }
        }
    }
    @Test func allProducerStatesDecodeWithoutInferringPaymentFromNavigation() throws {
        for name in ["order", "pending", "expired", "unknown", "ready"] { try order(name).validate() }
        #expect(try order("order").canRequestCheckout(at: date))
        #expect(try order("expired").canRequestCheckout(at: date))
        #expect(try !order("pending").canRequestCheckout(at: date.addingTimeInterval(86_400)))
        #expect(try !order("unknown").canRequestCheckout(at: date.addingTimeInterval(86_400)))
        #expect(try !order("pending").canClaim(at: date))
        #expect(try order("ready").canClaim(at: date))
        #expect(try order("unknown").message == "Проверяем платёж. Повторно платить пока не нужно.")
    }
    @Test func refundsAndContradictoryReadinessNeverOfferPaymentOrConnect() throws {
        for state in ["partially_paid", "partially_refunded", "refunded", "refund_review", "additional_payment_review", "unknown"] {
            let data = try fixture("ready") { var v = $0; v["payment_state"] = state; return v }
            let value = try WaiVDSContract.decode(WaiVDSOrder.self, from: data)
            #expect(!value.canClaim(at: date) && !value.canRequestCheckout(at: date))
        }
        let data = try fixture("ready") { var v = $0; v["home_state"] = "installing"; return v }
        #expect(try !WaiVDSContract.decode(WaiVDSOrder.self, from: data).canClaim(at: date))
        let refund = try fixture("ready") { var v = $0; v["order_status"] = "needs_refund"; v["payment_state"] = "refund_review"; return v }
        #expect(try WaiVDSContract.decode(WaiVDSOrder.self, from: refund).message != "Возврат оформлен.")
    }
    @Test func checkoutOnlyOpensVerifiedUnexpiredURLOnExactProcessorHost() throws {
        let pending = try WaiVDSContract.decode(WaiVDSCheckout.self, from: fixture("pending"))
        #expect(try pending.browserURL(at: date)?.host == "checkout.stripe.com")
        #expect(throws: WaiVDSFailure.paymentPending) { try pending.browserURL(at: date.addingTimeInterval(3600)) }
        for url in ["http://checkout.stripe.com/pay", "https://checkout.stripe.com.evil/pay", "https://user@checkout.stripe.com/pay", "https://checkout.stripe.com:444/pay", "https://checkout.stripe.com/pay#secret", "https://pay.cryptomus.com/pay"] {
            let data = try fixture("pending") { var v = $0; v["url"] = url; return v }
            #expect(throws: WaiVDSFailure.self) { try WaiVDSContract.decode(WaiVDSCheckout.self, from: data).browserURL(at: date) }
        }
        let empty = try fixture("pending") { var v = $0; v["url"] = NSNull(); return v }
        #expect(try WaiVDSContract.decode(WaiVDSCheckout.self, from: empty).browserURL(at: date) == nil)
        let unknown = try fixture("pending") { var v = $0; v["payment_state"] = "unknown"; return v }
        #expect(throws: WaiVDSFailure.self) { try WaiVDSContract.decode(WaiVDSCheckout.self, from: unknown).browserURL(at: date) }
    }
    @Test func oneUseCallbacksRequireExactDestinationIssuerAndUniqueState() throws {
        let state = "test-owner-state-123456"
        let valid = URL(string: "openstrudel://oauth/wai-vds?state=\(state)&code=\(hex)&iss=https://server.waiwai.is")!
        #expect(try WaiVDSContract.callbackParameters(valid, expected: WaiVDSContract.callback, state: state)["code"] == hex)
        for url in ["openstrudel://oauth.evil/wai-vds", "openstrudel://user@oauth/wai-vds", "openstrudel://oauth:443/wai-vds", "openstrudel://oauth/wai-vds/", "https://oauth/wai-vds"] {
            #expect(throws: WaiVDSFailure.callback) { try WaiVDSContract.callbackParameters(URL(string: url + "?state=" + state)!, expected: WaiVDSContract.callback, state: state) }
        }
        for suffix in ["&state=\(state)", "#fragment", "&code=duplicate"] {
            #expect(throws: WaiVDSFailure.callback) { try WaiVDSContract.callbackParameters(URL(string: valid.absoluteString + suffix)!, expected: WaiVDSContract.callback, state: state) }
        }
    }
    @Test func emulatedPrivateOrUnboundHomesNeverReceiveOwnerCredential() throws {
        let original = try WaiVDSContract.decode(WaiVDSConnectionClaim.self, from: fixture("connection"))
        #expect(throws: WaiVDSFailure.identity) { try original.endpoint(for: original.installationId, release: original.releaseSha256) }
        for url in ["https://127.0.0.1:7789", "https://169.254.169.254:7789", "https://192.0.2.10:7789", "https://203.0.113.1:7789", "https://8.8.8.8:7789?token=x", "https://8.8.8.8:443", "https://user@8.8.8.8:7789"] {
            let data = try fixture("connection") { var v = $0; v["mode"] = "kamatera"; v["url"] = url; return v }
            let c = try WaiVDSContract.decode(WaiVDSConnectionClaim.self, from: data)
            #expect(throws: WaiVDSFailure.identity) { try c.endpoint(for: c.installationId, release: c.releaseSha256) }
        }
        let live = try fixture("connection") { var v = $0; v["mode"] = "kamatera"; v["url"] = "https://8.8.8.8:7789"; return v }
        let c = try WaiVDSContract.decode(WaiVDSConnectionClaim.self, from: live)
        #expect(try c.endpoint(for: c.installationId, release: c.releaseSha256).host == "8.8.8.8")
        #expect(throws: WaiVDSFailure.identity) { try c.endpoint(for: UUID().uuidString.lowercased(), release: c.releaseSha256) }
        #expect(throws: WaiVDSFailure.identity) { try c.endpoint(for: c.installationId, release: hex) }
    }
    @Test func tlsRequiresCertificateAndDeviceKeyBeforeAuthorization() {
        let key = P256.Signing.PrivateKey().publicKey.x963Representation
        #expect(WaiVDSHomeTrust.matches(host: "8.8.8.8", port: 7789, pin: hex, publicKey: key, expectedHost: "8.8.8.8", expectedPin: hex, expectedKey: key))
        #expect(!WaiVDSHomeTrust.matches(host: "8.8.8.8", port: 7789, pin: String(repeating: "b", count: 64), publicKey: key, expectedHost: "8.8.8.8", expectedPin: hex, expectedKey: key))
        #expect(!WaiVDSHomeTrust.matches(host: "8.8.8.8", port: 7789, pin: hex, publicKey: P256.Signing.PrivateKey().publicKey.x963Representation, expectedHost: "8.8.8.8", expectedPin: hex, expectedKey: key))
    }

    @MainActor @Test func loginPersistsPKCEThenConsumesCodeBeforeExchange() async throws {
        let store = WaiVDSMemoryStore(); let http = WaiVDSFakeHTTP()
        let client = try WaiVDSClient(store: store, transport: http, now: { date })
        let authorization = try client.beginSignIn(fresh: true)
        let login = try #require(store.state().login)
        let params = URLComponents(url: authorization, resolvingAgainstBaseURL: false)!.queryItems!
        #expect(params.first { $0.name == "code_challenge" }?.value == DigitalOceanOAuth.challenge(login.verifier))
        #expect(params.first { $0.name == "prompt" }?.value == "login")
        http.handler = { request in
            #expect(request.url?.absoluteString == WaiVDSContract.origin + "/oauth/token")
            #expect(try store.state().login == nil)
            #expect(try object(request.httpBody!)["code_verifier"] as? String == login.verifier)
            return try http.reply(request, json: ["access_token": "os_access_" + hex, "refresh_token": "os_refresh_" + hex,
                                                 "token_type": "Bearer", "scope": "home:manage", "expires_in": 900, "refresh_expires_in": 86_400])
        }
        let callback = URL(string: WaiVDSContract.callback + "?state=\(login.state)&code=\(hex)&iss=\(WaiVDSContract.origin)")!
        try await client.finishSignIn(callback)
        #expect(try store.state().tokens != nil)
        await #expect(throws: WaiVDSFailure.signIn) { try await client.finishSignIn(callback) }
        #expect(http.requests.count == 1)
    }
    @MainActor @Test func wrongIssuerAndCancellationNeverExchangeCode() async throws {
        let store = WaiVDSMemoryStore(); let http = WaiVDSFakeHTTP()
        let client = try WaiVDSClient(store: store, transport: http, now: { date })
        _ = try client.beginSignIn(); let login = try #require(store.state().login)
        await #expect(throws: WaiVDSFailure.callback) {
            try await client.finishSignIn(URL(string: WaiVDSContract.callback + "?state=\(login.state)&code=\(hex)&iss=https://evil.example")!)
        }
        _ = try client.beginSignIn(); let cancel = try #require(store.state().login)
        await #expect(throws: CancellationError.self) { try await client.finishSignIn(URL(string: WaiVDSContract.callback + "?state=\(cancel.state)&error=access_denied")!) }
        let saved = try store.state()
        #expect(http.requests.isEmpty && saved.login == nil)
    }
    @MainActor @Test func refreshTimeoutCannotReplayCredentialAfterRestart() async throws {
        var state = loggedIn(); let old = state.tokens!
        state.tokens = .init(access: old.access, refresh: old.refresh, expiresAt: date.addingTimeInterval(-1), refreshExpiresAt: old.refreshExpiresAt, signedInAt: old.signedInAt, sessionId: old.sessionId)
        let store = try WaiVDSMemoryStore(state); let http = WaiVDSFakeHTTP()
        http.handler = { _ in #expect(try store.state().tokens == nil); throw URLError(.timedOut) }
        let client = try WaiVDSClient(store: store, transport: http, now: { date })
        await #expect(throws: WaiVDSFailure.self) { try await client.resume() }
        let restored = try WaiVDSClient(store: store, transport: http, now: { date })
        await #expect(throws: WaiVDSFailure.signIn) { try await restored.resume() }
        #expect(http.requests.count == 1)
    }
    @MainActor @Test func unknownCreatePersistsExactPayloadAndResumeDoesNotPost() async throws {
        let store = try WaiVDSMemoryStore(prepared()); let http = WaiVDSFakeHTTP()
        http.handler = { request in
            let intent = try #require(store.state().intent)
            #expect(intent.attempted && intent.payload == request.httpBody)
            let installation = try #require(store.state().installations[intent.installationId])
            let wire = try object(request.httpBody!); let bootstrap = try #require(wire["bootstrap"] as? [String: String])
            #expect(bootstrap["ownerTokenHash"] == WaiVDSContract.hash(Data(installation.ownerToken.utf8)))
            #expect(!String(data: request.httpBody!, encoding: .utf8)!.contains(installation.ownerToken))
            throw URLError(.timedOut)
        }
        let client = try WaiVDSClient(store: store, transport: http, now: { date })
        await #expect(throws: WaiVDSFailure.unknownResult) { try await client.confirmOrder(quoteId: quote().quoteId) }
        let original = try #require(http.requests.first?.httpBody)
        let restored = try WaiVDSClient(store: store, transport: http, now: { date.addingTimeInterval(300) })
        http.handler = { request in try http.reply(request, json: ["orders": []]) }
        #expect(try await restored.resume().isEmpty)
        #expect(http.requests.last?.httpMethod == "GET")
        http.handler = { request in
            #expect(request.httpBody == original)
            var v = try object(fixture("order")); v["installation_id"] = try store.state().intent!.installationId
            return try http.reply(request, json: v)
        }
        let order = try await restored.retrySavedOrder()
        #expect(order.orderId == restored.savedOrder?.orderId)
        #expect(http.requests.filter { $0.httpMethod == "POST" }.count == 2)
    }
    @MainActor @Test func keychainFailurePreventsAnyOrderPOST() async throws {
        let store = try WaiVDSMemoryStore(prepared()); let http = WaiVDSFakeHTTP(); store.failWrites = true
        let client = try WaiVDSClient(store: store, transport: http, now: { date })
        await #expect(throws: WaiVDSFailure.storage) { try await client.confirmOrder(quoteId: quote().quoteId) }
        #expect(http.requests.isEmpty)
    }
    @MainActor @Test func changedAmountOrOwnerCannotRebindSavedOrder() async throws {
        var state = try savedIntent(); let old = state.tokens!
        state.tokens = .init(access: old.access, refresh: old.refresh, expiresAt: old.expiresAt, refreshExpiresAt: old.refreshExpiresAt, signedInAt: date, sessionId: "different-login")
        let store = try WaiVDSMemoryStore(state); let http = WaiVDSFakeHTTP()
        let client = try WaiVDSClient(store: store, transport: http, now: { date })
        http.handler = { request in try http.reply(request, json: ["orders": []]) }
        await #expect(throws: WaiVDSFailure.wrongAccount) { try await client.resume() }
        await #expect(throws: WaiVDSFailure.wrongAccount) { try await client.retrySavedOrder() }
        http.handler = { request in
            var v = try object(fixture("order")); v["amount_minor"] = 2500
            return try http.reply(request, json: ["orders": [v]])
        }
        await #expect(throws: WaiVDSFailure.wrongAccount) { try await client.resume() }
        http.handler = { request in try http.reply(request, json: ["orders": [try object(fixture("order"))]]) }
        _ = try await client.resume()
        #expect(try store.state().intent?.sessionId == "different-login")
        #expect(http.requests.allSatisfy { $0.httpMethod == "GET" })
    }
    @MainActor @Test func uncertainPaymentOnlySyncsAndNeverCreatesAnotherInvoice() async throws {
        var state = try savedIntent(name: "unknown"); state.intent?.checkoutUncertain = true
        let store = try WaiVDSMemoryStore(state); let http = WaiVDSFakeHTTP()
        http.handler = { request in try http.reply(request, data: fixture("unknown")) }
        let client = try WaiVDSClient(store: store, transport: http, now: { date })
        await #expect(throws: WaiVDSFailure.paymentPending) { try await client.checkout() }
        #expect(http.requests.count == 1 && http.requests[0].url!.path.hasSuffix("/sync"))
        #expect(client.hasUncertainCheckout)
    }
    @MainActor @Test func lostCheckoutResponseIsDurableAndRawReturnCannotMarkPaid() async throws {
        let store = try WaiVDSMemoryStore(savedIntent()); let http = WaiVDSFakeHTTP()
        http.handler = { request in
            if request.url!.path.hasSuffix("/sync") { return try http.reply(request, data: fixture("order")) }
            #expect(try store.state().intent?.checkoutUncertain == true)
            throw URLError(.timedOut)
        }
        let client = try WaiVDSClient(store: store, transport: http, now: { date })
        await #expect(throws: WaiVDSFailure.unknownResult) { try await client.checkout() }
        let restored = try WaiVDSClient(store: store, transport: http, now: { date })
        await #expect(throws: WaiVDSFailure.paymentPending) { try await restored.checkout() }
        #expect(http.requests.filter { $0.url!.path.hasSuffix("/checkout") }.count == 1)
        let intent = try #require(store.state().intent)
        let callback = URL(string: WaiVDSContract.paymentCallback + "?order_id=\(intent.order!.orderId)&state=\(intent.returnState)")!
        http.handler = { request in try http.reply(request, data: fixture("unknown")) }
        #expect(try await restored.handlePaymentReturn(callback).paymentState == "unknown")
        await #expect(throws: WaiVDSFailure.callback) { try await restored.handlePaymentReturn(URL(string: callback.absoluteString + "&paid=true")!) }
    }
    @MainActor @Test func verifiedUnpaidExpiryCanResumeSameOrder() async throws {
        var state = try savedIntent(name: "unknown"); state.intent?.checkoutUncertain = true
        let store = try WaiVDSMemoryStore(state); let http = WaiVDSFakeHTTP()
        http.handler = { request in try http.reply(request, data: fixture(request.url!.path.hasSuffix("/sync") ? "expired" : "pending")) }
        let client = try WaiVDSClient(store: store, transport: http, now: { date })
        #expect(try await client.checkout()?.host == "checkout.stripe.com")
        #expect(http.requests.count == 2 && http.requests.allSatisfy { $0.url!.path.contains(state.intent!.order!.orderId) })
    }
    @MainActor @Test func unauthorizedHostingDoesNotEraseInstallationOrSuggestOpenAI() async throws {
        let store = try WaiVDSMemoryStore(savedIntent()); let http = WaiVDSFakeHTTP()
        http.handler = { request in try http.reply(request, json: ["error": "private details must not be shown"], status: 401) }
        let client = try WaiVDSClient(store: store, transport: http, now: { date })
        await #expect(throws: WaiVDSFailure.signIn) { try await client.resume() }
        #expect(try store.state().tokens == nil && !store.state().installations.isEmpty)
        #expect(!WaiVDSFailure.signIn.localizedDescription.contains("OpenAI"))
    }
    @MainActor @Test func overlappingOperationsCannotRefreshOrOrderTwice() async throws {
        let store = try WaiVDSMemoryStore(loggedIn()); let http = WaiVDSFakeHTTP()
        var continuation: CheckedContinuation<Void, Never>?
        http.handler = { request in
            await withCheckedContinuation { continuation = $0 }
            return try http.reply(request, json: ["orders": []])
        }
        let client = try WaiVDSClient(store: store, transport: http, now: { date })
        let first = Task { try await client.resume() }
        while continuation == nil { await Task.yield() }
        await #expect(throws: WaiVDSFailure.busy) { try await client.resume() }
        #expect(throws: WaiVDSFailure.busy) { try client.beginSignIn() }
        continuation?.resume(); _ = try await first.value
        #expect(http.requests.count == 1)
    }
    @MainActor @Test func redirectsCannotSupplyOrdersOrReceiveForwardedCredentials() async throws {
        let store = try WaiVDSMemoryStore(loggedIn()); let http = WaiVDSFakeHTTP()
        http.handler = { request in
            #expect(request.url!.host == "server.waiwai.is")
            return (Data(), HTTPURLResponse(url: request.url!, statusCode: 307, httpVersion: nil,
                                           headerFields: ["Content-Type": "application/json", "Location": "https://evil.example"])!)
        }
        let client = try WaiVDSClient(store: store, transport: http, now: { date })
        await #expect(throws: WaiVDSFailure.response) { try await client.resume() }
        #expect(http.requests.count == 1)
    }
    @MainActor @Test func emulatorReadyNeverIssuesConnectionClaim() async throws {
        let store = try WaiVDSMemoryStore(savedIntent(name: "ready")); let http = WaiVDSFakeHTTP()
        http.handler = { request in try http.reply(request, data: fixture("ready")) }
        let client = try WaiVDSClient(store: store, transport: http, now: { date })
        await #expect(throws: WaiVDSFailure.identity) { try await client.claimConnection() }
        #expect(http.requests.count == 1 && http.requests[0].url!.path.hasSuffix("/sync"))
    }
    @MainActor @Test func closedCatalogNeverRequestsQuoteOrCharges() async throws {
        let store = try WaiVDSMemoryStore(loggedIn()); let http = WaiVDSFakeHTTP()
        http.handler = { request in
            if request.url!.path.hasSuffix("/orders") { return try http.reply(request, json: ["orders": []]) }
            return try http.reply(request, data: fixture("catalog"))
        }
        let client = try WaiVDSClient(store: store, transport: http, now: { date })
        await #expect(throws: WaiVDSFailure.unavailable) { try await client.quote(paymentMethod: "card") }
        #expect(http.requests.allSatisfy { $0.httpMethod == "GET" })
    }
    @MainActor @Test func enabledCatalogYieldsExactOfferBeforeAnyOrderRequest() async throws {
        let store = try WaiVDSMemoryStore(loggedIn()); let http = WaiVDSFakeHTTP()
        let expected = try quote()
        http.handler = { request in
            if request.url!.path.hasSuffix("/orders") { return try http.reply(request, json: ["orders": []]) }
            if request.url!.path.hasSuffix("/catalog") {
                var v = try object(fixture("catalog")); v["mode"] = "emulator"; v["purchase_enabled"] = true
                v["profile"] = try object(fixture("quote"))["profile"]
                v["payment_methods"] = [["id": "card", "currency": "USD", "amount_minor": 2400, "currency_exponent": 2]]
                v["platforms"] = ["mac": ["purchase_enabled": true], "web": ["purchase_enabled": true], "ios": ["purchase_enabled": false, "mode": "join_by_invitation"]]
                return try http.reply(request, json: v)
            }
            #expect(request.url!.path.hasSuffix("/quotes"))
            #expect(try object(request.httpBody!)["platform"] as? String == "mac")
            return try http.reply(request, data: fixture("quote"), status: 201)
        }
        let client = try WaiVDSClient(store: store, transport: http, now: { date })
        #expect(try await client.quote(paymentMethod: "card") == expected)
        #expect(try store.state().offer?.quote == expected && store.state().intent == nil)
        #expect(http.requests.filter { $0.httpMethod == "POST" }.count == 1)
    }
    @MainActor @Test func definitiveQuoteRejectionAllowsNewOfferButKeepsInstallationKeys() async throws {
        let store = try WaiVDSMemoryStore(prepared()); let http = WaiVDSFakeHTTP()
        http.handler = { request in try http.reply(request, json: ["error": "expired", "code": "quote_expired"], status: 409) }
        let client = try WaiVDSClient(store: store, transport: http, now: { date })
        await #expect(throws: WaiVDSFailure.quoteExpired) { try await client.confirmOrder(quoteId: quote().quoteId) }
        let saved = try store.state()
        #expect(saved.intent == nil && saved.offer == nil && saved.installations.count == 1)
        #expect(http.requests.count == 1)
    }
    @MainActor @Test func renewalNeverReplacesExistingHomeKeysOrSendsBootstrap() async throws {
        var state = try savedIntent(name: "ready"); let previous = state.installations
        let data = try fixture("quote") {
            var v = $0; v["kind"] = "renewal"; v["installation_id"] = state.intent!.installationId
            v["starts_at"] = "current_period_end_or_payment"; v["quote_id"] = UUID().uuidString.lowercased(); return v
        }
        let renewal = try WaiVDSContract.decode(WaiVDSQuote.self, from: data)
        state.offer = .init(quote: renewal, sessionId: state.tokens!.sessionId)
        let store = try WaiVDSMemoryStore(state); let http = WaiVDSFakeHTTP()
        http.handler = { request in
            #expect(try object(request.httpBody!)["bootstrap"] == nil)
            var order = try object(fixture("order")); order["kind"] = "renewal"; order["quote_id"] = renewal.quoteId
            return try http.reply(request, json: order)
        }
        let client = try WaiVDSClient(store: store, transport: http, now: { date })
        #expect(try await client.confirmOrder(quoteId: renewal.quoteId).kind == "renewal")
        #expect(try store.state().installations.values.first?.privateKeyPEM == previous.values.first?.privateKeyPEM)
        #expect(try store.state().installations.values.first?.ownerToken == previous.values.first?.ownerToken)
    }
    @MainActor @Test func lostCodeExchangeCannotBeReplayed() async throws {
        let store = WaiVDSMemoryStore(); let http = WaiVDSFakeHTTP()
        let client = try WaiVDSClient(store: store, transport: http, now: { date })
        _ = try client.beginSignIn(); let login = try #require(store.state().login)
        http.handler = { _ in throw URLError(.timedOut) }
        let callback = URL(string: WaiVDSContract.callback + "?state=\(login.state)&code=\(hex)&iss=\(WaiVDSContract.origin)")!
        await #expect(throws: WaiVDSFailure.unknownResult) { try await client.finishSignIn(callback) }
        let restored = try WaiVDSClient(store: store, transport: http, now: { date })
        await #expect(throws: WaiVDSFailure.signIn) { try await restored.finishSignIn(callback) }
        #expect(http.requests.count == 1)
    }
}

@MainActor private final class WaiVDSMemoryStore: WaiVDSCredentialStore {
    var data: Data?; var failWrites = false
    init() {}
    init(_ state: WaiVDSSavedState) throws { data = try JSONEncoder().encode(state) }
    func load() throws -> Data? { data }
    func save(_ data: Data) throws { if failWrites { throw WaiVDSFailure.storage }; self.data = data }
    func state() throws -> WaiVDSSavedState { try data.map { try JSONDecoder().decode(WaiVDSSavedState.self, from: $0) } ?? .init() }
}
@MainActor private final class WaiVDSFakeHTTP: WaiVDSTransport {
    var requests: [URLRequest] = []
    var handler: ((URLRequest) async throws -> (Data, HTTPURLResponse))?
    func send(_ request: URLRequest) async throws -> (Data, HTTPURLResponse) {
        requests.append(request)
        guard let handler else { throw URLError(.badServerResponse) }
        return try await handler(request)
    }
    func reply(_ request: URLRequest, data: Data, status: Int = 200) -> (Data, HTTPURLResponse) {
        (data, HTTPURLResponse(url: request.url!, statusCode: status, httpVersion: nil, headerFields: ["Content-Type": "application/json"])!)
    }
    func reply(_ request: URLRequest, json: [String: Any], status: Int = 200) throws -> (Data, HTTPURLResponse) {
        reply(request, data: try JSONSerialization.data(withJSONObject: json), status: status)
    }
}
