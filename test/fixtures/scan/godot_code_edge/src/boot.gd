extends Node
func _ready() -> void:
	add_child(NeedsArgScreen.new(3))
	add_child(OneLineScreen.new())
