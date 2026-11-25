extends Node
# Four ways a screen is made that are not `ClassName.new()`.
var ShopRef = preload("res://src/ui/shop_menu.gd")

func _ready() -> void:
	add_child(ShopRef.new())
	add_child(preload("res://src/ui/pause_menu.gd").new())
	add_child(load("res://src/ui/levels_menu.gd").new())
	ResourceLoader.load_threaded_request("res://src/ui/queued_menu.gd")
