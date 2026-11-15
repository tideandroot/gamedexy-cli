extends Control
var coins := 0
func _on_play_pressed():
	get_tree().change_scene_to_file("res://scenes/level.tscn")
func _on_shop_pressed():
	$ShopPopup.popup_centered()
func _ready():
	var now = Time.get_unix_time_from_system() # daily reward
