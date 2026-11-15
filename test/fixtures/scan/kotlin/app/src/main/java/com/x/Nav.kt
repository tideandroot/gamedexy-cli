package com.x
@Composable
fun AppNav(nav: NavHostController) {
    NavHost(nav, startDestination = "home") {
        composable("home") { HomeScreen(onShop = { nav.navigate("shop") }) }
        composable("shop") { ShopScreen() }
    }
}
@Composable
fun HomeScreen(onShop: () -> Unit) {
    var coins by remember { mutableStateOf(0) }
    if (showOffer) { AlertDialog(onDismissRequest = {}) }
}
@Composable
fun ShopScreen() {
    val p = QueryProductDetailsParams.Product.newBuilder().setProductId("gems_100").setProductType(BillingClient.ProductType.INAPP)
    RewardedAd.load(ctx, "unit", req, cb)
}
enum class Chapter { FOREST, RIVER, PEAK }
class LevelUp(val xp: Int)
fun bonus() = listOf(LevelUp(1), LevelUp(2))
