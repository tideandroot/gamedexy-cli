using UnityEngine;
using UnityEngine.SceneManagement;
public class MenuController : MonoBehaviour {
    [SerializeField] GameObject shopPanel;
    public int gems = 0;
    public void Play() { SceneManager.LoadScene("Game"); }
    public void OpenShop() { shopPanel.SetActive(true); }
    void Init(ConfigurationBuilder b) { b.AddProduct("gems_500", ProductType.Consumable); }
    void Ad() { Advertisement.Show("rewardedVideo"); }
    bool NewDay() => DateTime.Now.Date > last;
}
