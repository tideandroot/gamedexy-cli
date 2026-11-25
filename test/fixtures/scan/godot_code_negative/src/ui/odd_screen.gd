class_name OddScreen
extends Control
var _tab := 0

func _ready() -> void:
	match +_tab.length():
		0:
			pass
