extends Node
# Builds the whole game in code: no scenes besides this one.
var _sheets: ShopSheets
var _pause: PauseModal

func _ready() -> void:
	add_child(WorldView.new())
	var layer := CanvasLayer.new()
	add_child(layer)
	_sheets = ShopSheets.new()
	layer.add_child(_sheets)
	_pause = PauseModal.new()
	layer.add_child(_pause)
	layer.add_child(FlowRoot.new())
	var coin := CoinIcon.new()
	layer.add_child(coin)

func _on_shop_pressed(tab_id: String) -> void:
	_sheets.open_sheet(tab_id)

func _on_reward() -> void:
	_sheets.show_celebration("Nice", "You won")
