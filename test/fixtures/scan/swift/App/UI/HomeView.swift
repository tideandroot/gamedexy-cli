import SwiftUI
import StoreKit
enum Tab: String { case gems, coins }
struct HomeView: View {
    @State private var showShop = false
    @State private var showWin = false
    var body: some View {
        NavigationStack {
            VStack {
                // A comment that mentions ShopView() should not count.
                Button("Shop") { showShop = true }
                NavigationLink(destination: LevelMapView()) { Text("Levels") }
                if showWin { WinPopup() }
            }
            .sheet(isPresented: $showShop) { ShopView() }
            .alert("Out of lives", isPresented: $showWin) { Button("OK") {} }
        }
    }
}
struct ShopView: View {
    @State private var tab: Tab = .gems
    var body: some View {
        Picker("", selection: $tab) { Text("Gems").tag(Tab.gems); Text("Coins").tag(Tab.coins) }
        Button("Buy") { Task { _ = try? await Product.products(for: ["com.pebble.gems100"]) } }
    }
}
struct LevelMapView: View { var body: some View { Text("Map") } }
struct WinPopup: View { var body: some View { Text("You win").ignoresSafeArea() } }
struct OrphanScreen: View { var body: some View { Text("never opened") } }
struct Wallet { var gems = 0; var coins: Int = 50 }
func remind() { let c = UNMutableNotificationContent(); c.title = "Your lives are full"; _ = UNNotificationRequest(identifier: "lives", content: c, trigger: nil) }
func ask() { if Date() > .distantPast { SKStoreReviewController.requestReview() } }
