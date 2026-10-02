import AuthenticationServices
import Foundation
import Testing

@Suite(.serialized)
@MainActor struct DigitalOceanWebLoginTests {
    @Test func acceptsCompletionFromBackgroundQueue() async throws {
        var sessions: [ControlledWebSession] = []
        let login = DigitalOceanWebLogin { url, completion in
            let session = ControlledWebSession(url: url, completion: completion)
            sessions.append(session)
            return session
        }
        let destination = URL(string: "https://cloud.digitalocean.com/")!
        let callback = URL(string: "openstrudel://oauth/digitalocean?code=test&state=test")!
        let result = Task { try await login.open(destination) }
        while sessions.isEmpty { await Task.yield() }
        let completion = sessions[0].reply
        await Task.detached { completion(callback, nil) }.value
        #expect(try await result.value == callback)
    }

    @Test func canceledSessionCannotCompleteTheNextSignIn() async throws {
        var sessions: [ControlledWebSession] = []
        let login = DigitalOceanWebLogin { url, completion in
            let session = ControlledWebSession(url: url, completion: completion)
            sessions.append(session)
            return session
        }
        let destination = URL(string: "https://cloud.digitalocean.com/")!
        let first = Task { try await login.open(destination) }
        while sessions.isEmpty { await Task.yield() }
        login.cancel()
        do { _ = try await first.value; Issue.record("Canceled login returned a URL") }
        catch { #expect(error is CancellationError) }

        let second = Task { try await login.open(destination) }
        while sessions.count < 2 { await Task.yield() }
        let oldCompletion = sessions[0].reply
        let staleURL = URL(string: "openstrudel://oauth/digitalocean?code=stale")!
        await Task.detached { oldCompletion(staleURL, nil) }.value
        for _ in 0..<10 { await Task.yield() }
        let newCompletion = sessions[1].reply
        let expected = URL(string: "openstrudel://oauth/digitalocean?code=current")!
        await Task.detached { newCompletion(expected, nil) }.value
        #expect(try await second.value == expected)
    }
}

private final class ControlledWebSession: ASWebAuthenticationSession {
    let reply: DigitalOceanWebLogin.Completion
    init(url: URL, completion: @escaping DigitalOceanWebLogin.Completion) {
        reply = completion
        super.init(url: url, callbackURLScheme: "openstrudel", completionHandler: completion)
    }
    override func start() -> Bool { true }
    override func cancel() {}
}
