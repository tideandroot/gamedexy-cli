extends Node
# The launch scene: widgets are made here, plus a gameplay start.
func _ready() -> void:
	var box := VBoxContainer.new()
	add_child(box)
	box.add_child(ShopItemCard.new())
	box.add_child(SettingsToggle.new())
	box.add_child(ResultRow.new())
	box.add_child(MenuButtonBig.new())
	box.add_child(PageDots.new())
	box.add_child(Level.new())
	var run := CutScene.new()

func start_game() -> void:
	get_tree().change_scene_to_file("res://scenes/level.tscn")

func _show_summary() -> void:
	add_child(SummaryModal.new())
	add_child(OddScreen.new())
